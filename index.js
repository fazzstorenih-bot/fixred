import { Telegraf } from 'telegraf';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import P from "pino";
import qrcode from 'qrcode';
import fs from 'fs';
import nodemailer from 'nodemailer';
import csv from 'csv-parser';
import XLSX from 'xlsx';
import { PassThrough } from 'stream';
import axios from 'axios';
import path from 'path';

import {
  TELEGRAM_BOT_TOKEN,
  OWNER_ID,
  GROUP_LINK,
  VERIFICATION_GROUP_ID,
  WHATSAPP_EMAIL,
  EMAIL_SENDER,
  EMAIL_PASSWORD,
  COOLDOWN_DURATION,
  COOLDOWN_TIME,
  MAX_RECONNECT_ATTEMPTS,
  MT_FILE,
  PREMIUM_FILE,
  USER_DB,
  HISTORY_DB,
  BANNED_GROUP_DB,
  SETTINGS_DB,
  ALLOWED_FILE,
  ADMIN_FILE,
  RANDOM_NAMES,
  APPEAL_MESSAGES
} from './config.js';

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const SESSIONS_DIR = './database/sessions';
const MAX_SESSIONS = 10;
let whatsappSock = null;
let isWhatsAppConnected = false;
let qrCodeString = '';
let availableSessions = [];
let currentSessionIndex = -1;
let isSwitchingSession = false;

const premDBPath = './database/premium.json';
let _prem = {};
if (!fs.existsSync('./database')) {
    fs.mkdirSync('./database');
}
try {
    const data = fs.readFileSync(premDBPath, 'utf8');
    _prem = JSON.parse(data);
} catch (error) {
    fs.writeFileSync(premDBPath, JSON.stringify({}), 'utf8');
}

const formatWIB = (timestamp) => {
    return new Date(timestamp).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
};

const toMs = (str) => {
    if (!str) return 0;
    const match = str.toLowerCase().match(/^(\d+)([smhd]|mo)$/);
    if (!match) return 0;

    const num = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case 's': return num * 1000;
        case 'm': return num * 60 * 1000;
        case 'h': return num * 3600 * 1000;
        case 'd': return num * 86400 * 1000;
        case 'mo': return num * 2592000 * 1000;
        default: return 0;
    }
};

let allowedIds = [];
let adminIds = [];
const userCooldowns = new Map();

function initDbFile(filePath, defaultData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 4), 'utf8');
  }
}

setInterval(() => {
    let changed = false;
    const now = Date.now();
    Object.keys(_prem).forEach(userId => {
        if (_prem[userId] < now) {
            delete _prem[userId];
            changed = true;
        }
    });

    if (changed) {
        fs.writeFileSync(premDBPath, JSON.stringify(_prem, null, 2));
    }
}, 30 * 60 * 1000);

function loadData() {
  try {
    const rawAllowed = fs.readFileSync(ALLOWED_FILE, 'utf8');
    allowedIds = JSON.parse(rawAllowed);
  } catch (e) {
    allowedIds = [];
  }

  try {
    const rawAdmin = fs.readFileSync(ADMIN_FILE, 'utf8');
    adminIds = JSON.parse(rawAdmin);
  } catch (e) {
    adminIds = [];
  }
}

function saveAllowed() {
  try {
    fs.writeFileSync(ALLOWED_FILE, JSON.stringify(allowedIds, null, 2), 'utf8');
  } catch (e) {
    console.error(e);
  }
}

function saveAdmin() {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminIds, null, 2), 'utf8');
  } catch (e) {
    console.error(e);
  }
}

function isOwner(userId) {
  return userId === OWNER_ID;
}

const mess = { only: { owner: "Perintah ini hanya untuk Owner." } };

function isAdmin(userId) {
  return isOwner(userId) || adminIds.includes(userId);
}

function isAllowed(userId) {
  if (isAdmin(userId)) return true;
  if (allowedIds.includes(userId)) return true;
  const premKey = String(userId);
  if (_prem[premKey] && _prem[premKey] > Date.now()) {
    return true; 
  }
  return false;
}

function checkCooldown(userId) {
  if (isAdmin(userId)) return { allowed: true, remaining: 0 };
  const premKey = String(userId);
  if (_prem[premKey] && _prem[premKey] > Date.now()) {
      return { allowed: true, remaining: 0 };
  }  
  const now = Date.now();
  const lastUsed = userCooldowns.get(userId);  
  if (lastUsed) {
    const timePassed = now - lastUsed;
    if (timePassed < COOLDOWN_TIME) {
      const remaining = Math.ceil((COOLDOWN_TIME - timePassed) / 1000);
      return { 
        allowed: false, 
        remaining 
      };
    }
  }  
  userCooldowns.set(userId, now);
  return { allowed: true, remaining: 0 };
}

function getRandomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
}

function getRandomAppealMessage(name, number) {
  const randomIndex = Math.floor(Math.random() * APPEAL_MESSAGES.length);
  return APPEAL_MESSAGES[randomIndex]
    .replace('(NAME)', name)
    .replace('+NUMBER', number);
}

function isRepeNumber(number) {
  const numStr = number.toString();
  if (/(\d)\1{2,}/.test(numStr)) return true;
  
  const digits = numStr.split('').map(Number);
  let sequentialUp = true;
  let sequentialDown = true;
  
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== digits[i-1] + 1) sequentialUp = false;
    if (digits[i] !== digits[i-1] - 1) sequentialDown = false;
  }
  
  if (sequentialUp || sequentialDown) return true;
  if (numStr === numStr.split('').reverse().join('')) return true;
  
  if (numStr.length % 2 === 0) {
    const half = numStr.length / 2;
    if (numStr.slice(0, half) === numStr.slice(half)) return true;
  }
  
  return false;
}

function getVerificationPercentage(number) {
  const numStr = number.toString();
  if (isRepeNumber(number)) return 99;
  if (/(\d)\1{3,}/.test(numStr)) return 95;
  if (/(\d)\1{2,}/.test(numStr)) return 90;
  
  const digits = numStr.split('').map(Number);
  let sequentialUp = true;
  let sequentialDown = true;
  
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== digits[i-1] + 1) sequentialUp = false;
    if (digits[i] !== digits[i-1] - 1) sequentialDown = false;
  }
  
  if (sequentialUp || sequentialDown) return 85;
  
  if (numStr.length >= 6) {
    if (numStr.length % 2 === 0) {
      const half = numStr.length / 2;
      if (numStr.slice(0, half) === numStr.slice(half)) return 80;
    }
    if (/(\d)\1(\d)\2(\d)\3/.test(numStr)) return 75;
  }
  
  if (numStr.length >= 12) return 70;
  if (numStr.length >= 10) return 60;
  if (numStr.length >= 8) return 50;
  
  return 40;
}

function getJamPercentage(bio, setAt, metaBusiness) {
  let basePercentage = 50;
  
  if (bio && bio.length > 0) {
    if (bio.length > 100) basePercentage -= 20;
    else if (bio.length > 50) basePercentage -= 15;
    else if (bio.length > 20) basePercentage -= 10;
    else basePercentage -= 5;
  } else {
    basePercentage += 15;
  }
  
  if (setAt) {
    const now = new Date();
    const bioDate = new Date(setAt);
    const diffTime = Math.abs(now - bioDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 30) basePercentage -= 20;
    else if (diffDays < 90) basePercentage -= 10;
    else if (diffDays > 365) basePercentage += 15;
    else if (diffDays > 730) basePercentage += 25;
  } else {
    basePercentage += 10;
  }
  
  if (metaBusiness) {
    basePercentage -= 25;
  }
  
  basePercentage = Math.max(10, Math.min(90, basePercentage));
  return Math.round(basePercentage / 10) * 10;
}

function createProgressBar(current, total, length = 20) {
  const percentage = current / total;
  const filledLength = Math.round(length * percentage);
  const emptyLength = length - filledLength;
  
  const filledBar = '█'.repeat(filledLength);
  const emptyBar = '░'.repeat(emptyLength);
  
  return `[${filledBar}${emptyBar}]`;
}

async function checkMetaBusiness(jid) {
  try {
    const businessProfile = await whatsappSock.getBusinessProfile(jid);
    if (businessProfile) {
      return {
        isBusiness: true,
        businessData: businessProfile
      };
    }
    return { isBusiness: false, businessData: null };
  } catch (error) {
    return { isBusiness: false, businessData: null };
  }
}

function createBioResultFile(results, totalNumbers, sourceType = 'Input Manual') {
  const timestamp = Date.now();
  const filename = `hasil_cekbio_${timestamp}.txt`;
  
  let fileContent = `HASIL CEK BIO SEMUA USER\n\n`;
  
  const withBio = results.filter(r => r.registered && r.bio && r.bio.length > 0);
  const withoutBio = results.filter(r => r.registered && (!r.bio || r.bio.length === 0));
  const notRegistered = results.filter(r => !r.registered);
  
  fileContent += `✅ Total nomor dicek : ${totalNumbers}\n`;
  fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
  fileContent += `📵 Tanpa Bio        : ${withoutBio.length}\n`;
  fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n`;
  fileContent += `📁 Sumber Data      : ${sourceType}\n\n`;
  fileContent += '----------------------------------------\n\n';
  
  if (withBio.length > 0) {
    fileContent += `✅ NOMOR YANG ADA BIO NYA (${withBio.length})\n\n`;
    
    const groupedByYear = {};
    withBio.forEach(result => {
      if (result.setAt) {
        const year = new Date(result.setAt).getFullYear();
        if (!groupedByYear[year]) {
          groupedByYear[year] = [];
        }
        groupedByYear[year].push(result);
      } else {
        if (!groupedByYear['Tidak Diketahui']) {
          groupedByYear['Tidak Diketahui'] = [];
        }
        groupedByYear['Tidak Diketahui'].push(result);
      }
    });
    
    const sortedYears = Object.keys(groupedByYear).sort((a, b) => {
      if (a === 'Tidak Diketahui') return 1;
      if (b === 'Tidak Diketahui') return -1;
      return parseInt(a) - parseInt(b);
    });
    
    sortedYears.forEach(year => {
      fileContent += `Tahun ${year}\n\n`;
      
      groupedByYear[year].forEach((result, index) => {
        fileContent += `└─ 📅 ${result.number}\n`;
        fileContent += `   └─ 📝 "${result.bio}"\n`;
        
        if (result.setAt) {
          const date = new Date(result.setAt);
          const dateStr = date.toLocaleDateString('id-ID', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
          const timeStr = date.toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
          fileContent += `      └─ ⏰ ${dateStr}, ${timeStr}\n`;
        }
        
        if (result.metaBusiness) {
          fileContent += `      └─ ✅ Nomor Ini Terdaftar Meta Business\n`;
        } else {
          fileContent += `      └─ ❌ Nomor Ini Tidak Ada Meta Businesses\n`;
        }
        
        const jamPercentage = result.jamPercentage || getJamPercentage(result.bio, result.setAt, result.metaBusiness);
        fileContent += `      └─ Untuk Nomor Ini 📮 ${jamPercentage}% Tidak Ngejam\n`;
        
        fileContent += '\n';
      });
    });
    
    fileContent += '----------------------------------------\n\n';
  }
  
  if (withoutBio.length > 0) {
    fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${withoutBio.length})\n\n`;
    
    withoutBio.forEach((result, index) => {
      fileContent += `${result.number}\n`;
      
      if (result.metaBusiness) {
        fileContent += `└─ ✅ Nomor Ini Terdaftar Meta Business\n`;
      } else {
        fileContent += `└─ ❌ Nomor Ini Tidak Ada Meta Businesses\n`;
      }
      
      const jamPercentage = result.jamPercentage || getJamPercentage(result.bio, result.setAt, result.metaBusiness);
      fileContent += `└─ Untuk Nomor Ini 📮 ${jamPercentage}% Tidak Ngejam\n`;
      
      fileContent += '\n';
    });
    
    fileContent += '\n----------------------------------------\n\n';
  }
  
  if (notRegistered.length > 0) {
    fileContent += `🚫 NOMOR TIDAK TERDAFTAR (${notRegistered.length})\n\n`;
    
    notRegistered.forEach((result, index) => {
      fileContent += `${result.number}\n`;
    });
  }
  
  fs.writeFileSync(filename, fileContent, 'utf8');
  return filename;
}

function createRepeResultFile(registeredRepe, notRegisteredRepe, notRepeNumbers) {
  const timestamp = Date.now();
  const filename = `repe_result_${timestamp}.txt`;
  
  let fileContent = `📚 Hasil cek repe\n\n`;
  
  if (registeredRepe.length > 0) {
    fileContent += `Nokos Repe yang terdaftar\n`;
    registeredRepe.forEach((item, index) => {
      fileContent += `✅ ${index + 1}. ${item.number}\n`;
    });
    fileContent += '\n';
  }
  
  if (notRegisteredRepe.length > 0) {
    fileContent += `Nokos Repe yang tidak terdaftar\n`;
    notRegisteredRepe.forEach((number, index) => {
      fileContent += `❌ ${index + 1}. ${number}\n`;
    });
    fileContent += '\n';
  }

  if (notRepeNumbers.registered.length > 0) {
    fileContent += `Nomor biasa yang terdaftar\n`;
    notRepeNumbers.registered.forEach((number, index) => {
      fileContent += `📱 ${index + 1}. ${number}\n`;
    });
    fileContent += '\n';
  }

  if (notRepeNumbers.notRegistered.length > 0) {
    fileContent += `Nomor biasa yang tidak terdaftar\n`;
    notRepeNumbers.notRegistered.forEach((number, index) => {
      fileContent += `🚫 ${index + 1}. ${number}\n`;
    });
  }
  
  fs.writeFileSync(filename, fileContent, 'utf8');
  return filename;
}

function initAllDb() {
  initDbFile(MT_FILE, []);
  initDbFile(PREMIUM_FILE, []);
  initDbFile(USER_DB, {});
  initDbFile(HISTORY_DB, []);
  initDbFile(BANNED_GROUP_DB, []);
  initDbFile('groups.json', {});
  initDbFile('owners.json', [OWNER_ID]);
  initDbFile('emails.json', []);
  initDbFile(SETTINGS_DB, {
    cooldown_duration: 60000,
    global_cooldown: 0,
    active_mt_id: 0,
    active_email_id: 0
  });
}

function readDb(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeDb(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8');
}

function getMtTexts() {
  return readDb(MT_FILE);
}

function getMtTextById(id) {
  return getMtTexts().find(mt => mt.id === id);
}

function getActiveMt() {
  const settings = readDb(SETTINGS_DB);
  const activeId = settings.active_mt_id || 0;
  return getMtTextById(activeId);
}

function setupTransporter() {
  const settings = readDb(SETTINGS_DB);
  const emails = readDb('emails.json');
  
  let emailUser = EMAIL_SENDER;
  let emailPass = EMAIL_PASSWORD;
  
  if (settings.active_email_id !== 0) {
    const activeEmail = emails.find(e => e.id === settings.active_email_id);
    if (activeEmail) {
      emailUser = activeEmail.email;
      emailPass = activeEmail.app_pass;
    }
  }
  
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: emailUser,
      pass: emailPass
    },
    timeout: 30000,
    connectionTimeout: 30000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: false
    }
  });
}

function getUser(userId) {
  const users = readDb(USER_DB);
  const defaultUser = {
    id: userId,
    username: 'N/A',
    status: isOwner(userId) ? 'owner' : 'free',
    is_banned: 0,
    last_fix: 0,
    fix_limit: 10,
    referral_points: 0,
    referred_by: null,
    referred_users: []
  };
  return users[userId] ? { ...defaultUser, ...users[userId] } : defaultUser;
}

function saveUser(user) {
  const users = readDb(USER_DB);
  users[user.id] = user;
  writeDb(USER_DB, users);
}

function saveHistory(data) {
  const history = readDb(HISTORY_DB);
  const newId = history.length > 0 ? history[history.length - 1].id + 1 : 1;
  history.push({ id: newId, ...data, timestamp: new Date().toISOString() });
  writeDb(HISTORY_DB, history);
}

async function switchToNextSession() {
    if (isSwitchingSession) return;
    isSwitchingSession = true;

    if (currentSessionIndex !== -1 && availableSessions[currentSessionIndex]) {
        const failedSessionPath = availableSessions[currentSessionIndex];
        console.log(`❌ Session ${path.basename(failedSessionPath)} is invalid or logged out.`);
        if (fs.existsSync(failedSessionPath)) {
            fs.rmSync(failedSessionPath, { recursive: true, force: true });
            console.log(`🗑️ Sesi gagal yang dihapus: ${path.basename(failedSessionPath)}`);
        }
    }

    scanForSessions();

    if (availableSessions.length > 0) {
        currentSessionIndex = 0;
        const nextSessionPath = availableSessions[currentSessionIndex];
        console.log(`🔄 Beralih ke sesi berikutnya yang tersedia: ${path.basename(nextSessionPath)}`);
        setTimeout(() => {
            isSwitchingSession = false;
            connectWhatsApp(nextSessionPath);
        }, 3000);
    } else {
        console.log('❌ Tidak ada lagi sesi yang tersedia. Menunggu sesi baru ditambahkan.');
        whatsappSock = null;
        isWhatsAppConnected = false;
        currentSessionIndex = -1;
        isSwitchingSession = false;
    }
}

async function connectWhatsApp(sessionPath) {
    console.log(`🔄 Mencoba terhubung dengan sesi: ${path.basename(sessionPath)}`);
    isWhatsAppConnected = false;

    if (whatsappSock) {
        try {
            await whatsappSock.logout();
        } catch {}
        whatsappSock.ev.removeAllListeners();
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        whatsappSock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: "silent" }),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            generateHighQualityLinkPreview: true,
        });

        whatsappSock.ev.on("creds.update", saveCreds);

        whatsappSock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const sessionName = path.basename(sessionPath);

            if (qr) {
                qrCodeString = qr;
                console.log(`📱 QR Code received for session ${sessionName}. Use /getqr to display.`);
            }

            if (connection === "open") {
                isWhatsAppConnected = true;
                qrCodeString = '';
                isSwitchingSession = false; 
                console.log(`✅ WhatsApp connected: ${whatsappSock.user.id} | Session: ${sessionName}`);
                try {
                    await bot.telegram.sendMessage(OWNER_ID,
                        `✅ *WhatsApp Session Terhubung!*\n\n` +
                        `🗂️ *Session:* ${sessionName}\n` +
                        `📱 *User ID:* ${whatsappSock.user.id}\n` +
                        `👤 *Nama:* ${whatsappSock.user.name || 'Tidak ada nama'}\n` +
                        `🔗 *Status:* Connected`, { parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    console.error('Gagal kirim notifikasi ke owner:', error);
                }
            }

            if (connection === "close") {
                isWhatsAppConnected = false;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log(`🔌 Connection closed for ${sessionName}, reason: ${lastDisconnect?.error?.message}. Reconnecting...`);
                } else {
                    await switchToNextSession();
                }
            }
        });

        whatsappSock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    console.log('Pesan masuk dari WhatsApp:', msg.key.remoteJid);
                }
            }
        });
    } catch (error) {
        console.error(`❌ Failed to start WhatsApp for session ${path.basename(sessionPath)}:`, error);
        await switchToNextSession();
    }
}

function scanForSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    availableSessions = fs.readdirSync(SESSIONS_DIR)
        .map(session => path.join(SESSIONS_DIR, session))
        .filter(fullPath => fs.statSync(fullPath).isDirectory());
}

async function startWhatsAppManager() {
    scanForSessions();

    if (availableSessions.length === 0) {
        console.log('📱 Tidak ditemukan sesi WhatsApp. Menunggu perintah /getpairing untuk membuat sesi baru.');
        return;
    }

    console.log(`Menemukan sesi ${availableSessions.length}. Mencoba terhubung ke sesi pertama: ${path.basename(availableSessions[0])}`);
    currentSessionIndex = 0;
    connectWhatsApp(availableSessions[0]);
}

async function readTxtFile(fileBuffer) {
  const content = fileBuffer.toString('utf8');
  return content.split(/[\r\n]+/).filter(num => num.trim().length > 0);
}

async function readCsvFile(fileBuffer) {
  return new Promise((resolve, reject) => {
    const numbers = [];
    const bufferStream = new PassThrough();
    bufferStream.end(fileBuffer);
    
    bufferStream
      .pipe(csv())
      .on('data', (row) => {
        Object.values(row).forEach(value => {
          if (value && value.toString().trim().length > 0) {
            numbers.push(value.toString().trim());
          }
        });
      })
      .on('end', () => {
        resolve(numbers);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

async function readXlsxFile(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const numbers = [];
  
  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    data.flat().forEach(value => {
      if (value && value.toString().trim().length > 0) {
        numbers.push(value.toString().trim());
      }
    });
  });
  
  return numbers;
}

async function processFile(fileBuffer, fileName) {
  const fileExtension = fileName.toLowerCase().split('.').pop();
  
  switch (fileExtension) {
    case 'txt':
      return await readTxtFile(fileBuffer);
    case 'csv':
      return await readCsvFile(fileBuffer);
    case 'xlsx':
      return await readXlsxFile(fileBuffer);
    default:
      throw new Error(`Format file ${fileExtension} tidak didukung. Gunakan file TXT, CSV, atau XLSX.`);
  }
}

function getFileSourceType(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'txt': return 'File TXT';
    case 'csv': return 'File CSV';
    case 'xlsx': return 'File XLSX';
    default: return 'File';
  }
}

async function downloadTelegramFile(fileId, fileName) {
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    
    const response = await axios({
      method: 'GET',
      url: fileLink.href,
      responseType: 'arraybuffer'
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`Gagal mengunduh file: ${error.message}`);
  }
}

bot.command('getqr', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa mendapatkan QR Code.');
  }

  if (isWhatsAppConnected) {
    return ctx.reply('✅ WhatsApp sudah terhubung. Tidak perlu QR Code.');
  }

  if (!qrCodeString) {
    return ctx.reply('❌ QR Code belum tersedia. Gunakan /getpairing untuk memulai sesi baru.');
  }

  try {
    const qrImage = await qrcode.toBuffer(qrCodeString, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    await ctx.replyWithPhoto({ source: qrImage }, {
      caption: '📱 *SCAN QR CODE INI UNTUK MENGHUBUNGKAN WHATSAPP*\n\n' +
               '1. Buka WhatsApp di ponsel Anda\n' +
               '2. Ketuk menu ⋯ > Perangkat tertaut > Tautkan Perangkat\n' +
               '3. Arahkan kamera ke QR code ini\n\n' +
               'QR Code akan berubah setiap 30 detik',
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error generate QR code:', error);
    await ctx.reply('❌ Gagal generate QR Code. Coba lagi.');
  }
});

bot.command('getpairing', async (ctx) => {
    const userId = ctx.message.from.id;

    if (!isAllowed(userId)) {
        return ctx.reply('❌ Kamu belum dapat akses dari onwer! hubungi onwer untuk menggunakan bot.');
    }

    scanForSessions();
    if (availableSessions.length >= MAX_SESSIONS) {
        return ctx.reply(`❌ Batas maksimal ${MAX_SESSIONS} sesi telah tercapai. Hapus sesi lama untuk menambah yang baru.`);
    }

    if (isWhatsAppConnected) {
        await ctx.reply('⚠️ Sebuah sesi WhatsApp sedang aktif. Melanjutkan akan memutuskan sesi tersebut untuk memulai proses pairing baru.');
    }

    try {
        const phoneNumber = ctx.message.text.split(' ')[1];
        if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
            return ctx.reply('❌ Format: /getpairing <nomor_whatsapp_tanpa_+_atau_spasi>\n\nContoh: /getpairing 628123456789');
        }
        
        const sessionPath = path.join(SESSIONS_DIR, phoneNumber);

        if (fs.existsSync(sessionPath)) {
             return ctx.reply(`❌ Sesi untuk nomor ${phoneNumber} sudah ada. Jika ingin pairing ulang, hapus dulu sesi lama atau restart bot.`);
        }
        
        fs.mkdirSync(sessionPath, { recursive: true });
        
        await ctx.reply(`⏳ Memulai proses pairing untuk nomor ${phoneNumber}... Ini akan menjadi sesi aktif.`);
        await connectWhatsApp(sessionPath);
        scanForSessions();
        currentSessionIndex = availableSessions.findIndex(p => p === sessionPath);

        if (!whatsappSock) {
            return ctx.reply('❌ Gagal menginisialisasi koneksi WhatsApp. Coba lagi.');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const code = await whatsappSock.requestPairingCode(phoneNumber);
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        await ctx.reply(
            `📱 *PAIRING CODE WHATSAPP*\n\n` +
            `📞 Nomor: ${phoneNumber}\n` +
            `🔢 Kode: \`${formattedCode}\`\n\n` +
            `*Cara menggunakan:*\n` +
            `1. Buka WhatsApp di ponsel Anda\n` +
            `2. Masuk ke Settings > Linked Devices > Link a Device\n` +
            `3. Pilih "Link with Phone Number"\n` +
            `4. Masukkan kode di atas\n\n` +
            `⚠️ Kode ini berlaku terbatas, segera gunakan! Sesi akan disimpan sebagai \`${phoneNumber}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Error mendapatkan pairing code:', error);
        await ctx.reply(`❌ Gagal mendapatkan pairing code. Pastikan nomor valid dan coba lagi. Error: ${error.message}`);
    }
});

bot.command('wastatus', async (ctx) => {
    const userId = ctx.message.from.id;

    if (!isAdmin(userId)) {
        return ctx.reply('❌ Hanya admin yang bisa mengecek status WhatsApp.');
    }
    
    scanForSessions();

    let statusMessage = `📱 *STATUS WHATSAPP BOT*\n\n`;

    if (isWhatsAppConnected && whatsappSock && currentSessionIndex !== -1 && availableSessions[currentSessionIndex]) {
        const currentPath = availableSessions[currentSessionIndex];
        statusMessage += `✅ *Status:* Terhubung\n`;
        statusMessage += `🗂️ *Sesi Aktif:* ${path.basename(currentPath)} (${currentSessionIndex + 1}/${availableSessions.length})\n`;
        statusMessage += `📞 *Nomor:* ${whatsappSock.user?.id || 'Tidak diketahui'}\n`;
        statusMessage += `👤 *Nama:* ${whatsappSock.user?.name || 'Tidak ada nama'}\n`;
    } else if (qrCodeString) {
        statusMessage += `📱 *Status:* Menunggu Scan QR Code atau Pairing Code\n`;
        statusMessage += `🔗 *Info:* Gunakan /getqr atau /getpairing\n`;
    } else if (isSwitchingSession) {
        statusMessage += `🔄 *Status:* Beralih Sesi...\n`;
        statusMessage += `🔧 Bot sedang mencoba menghubungkan sesi berikutnya.\n`;
    } else {
        statusMessage += `❌ *Status:* Tidak Terhubung\n`;
        statusMessage += `🤷 *Info:* Tidak ada sesi aktif. Bot akan mencoba menghubungkan sesi yang ada jika tersedia.\n`;
    }

    statusMessage += `\n📦 *Total Sesi Tersimpan:* ${availableSessions.length} / ${MAX_SESSIONS}`;
    if (availableSessions.length > 0) {
        const sessionNames = availableSessions.map((s, i) => {
            const basename = path.basename(s);
            return (i === currentSessionIndex && isWhatsAppConnected) ? `*${basename}* (Aktif)` : basename;
        });
        statusMessage += `\n📋 *Antrian Sesi:* ${sessionNames.join(', ')}`;
    }

    statusMessage += `\n\nTerakhir diperbarui: ${new Date().toLocaleString('id-ID')}`;

    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
});

bot.command('fix', async (ctx) => {
  const userId = ctx.message.from.id;
  const chatId = ctx.message.chat.id;
  const username = ctx.message.from.username || ctx.message.from.first_name;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum terverifikasi! Join grup via tombol di /start untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  const messageText = ctx.message.text;
  const args = messageText.replace('/fix', '').trim().split(/\s+/);
  
  if (args.length === 0 || !args[0]) {
    return ctx.reply('❌ Format: /fix <nomor_whatsapp>\n\n📝 Contoh: `/fix +628123456789`', { parse_mode: 'Markdown' });
  }

  let number = args[0].replace(/[^0-9+]/g, '');
  if (number.startsWith('0')) {
    number = '62' + number.substring(1);
  } else if (number.startsWith('8')) {
    number = '62' + number;
  }

  if (number.length < 10 || number.length > 15) {
    return ctx.reply('❌ Format nomor tidak valid.');
  }

  const user = getUser(userId);
  
  if (!isAdmin(userId)) {
    if (user.fix_limit <= 0) {
      return ctx.reply(`❌ **Limit /fix** Anda sudah habis (${user.fix_limit}x).`);
    }
  }

  const activeTemplate = getActiveMt();
  if (!activeTemplate) {
    return ctx.reply('❌ Tidak ada template banding yang aktif. Silakan hubungi admin.');
  }

  try {
    const transporter = setupTransporter();
    const body = activeTemplate.body.replace(/{nomor}/g, number);
    
    await transporter.sendMail({
      from: transporter.options.auth.user,
      to: activeTemplate.to_email,
      subject: activeTemplate.subject,
      text: body
    });
    
    if (!isAdmin(userId)) {
      user.fix_limit -= 1;
      user.last_fix = Date.now();
      saveUser(user);
    }

    saveHistory({
      user_id: userId,
      username: username,
      command: `/fix ${number}`,
      number_fixed: number.replace('+', ''),
      email_used: transporter.options.auth.user,
      details: `Berhasil mengirim banding MT ID ${activeTemplate.id} ke ${activeTemplate.to_email}`
    });

    await ctx.reply(
      `✅ Nomor ${number} berhasil dibandinkan!\n\n` +
      `*Template:* ${activeTemplate.subject}\n` +
      `*Email:* ${transporter.options.auth.user}\n` +
      `*Limit tersisa:* ${user.fix_limit}x\n\n` +
      `Balasan dari WhatsApp akan otomatis dikirim ke chat ini.`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Error mengirim email:', error);
    await ctx.reply(`❌ Gagal mengirim banding untuk nomor ${number}:\n${error.message}`);
    
    saveHistory({
      user_id: userId,
      username: username,
      command: `/fix ${number}`,
      number_fixed: number.replace('+', ''),
      email_used: 'Gagal',
      details: `Gagal mengirim banding: ${error.message}`
    });
  }
});

bot.command('setmt', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa mengatur MT.');
  }

  const messageText = ctx.message.text;
  const parts = messageText.replace('/setmt', '').trim().split('|').map(p => p.trim());

  if (parts.length < 3) {
    return ctx.reply('❌ Format: /setmt <email_tujuan> | <subjek> | <isi_pesan>');
  }

  const [to_email, subject, body] = parts;

  if (!body.includes('{nomor}')) {
    return ctx.reply('❌ Isi pesan wajib mengandung `{nomor}` untuk placeholder nomor WhatsApp.');
  }

  const mtTexts = getMtTexts();
  const newId = mtTexts.length > 0 ? mtTexts[mtTexts.length - 1].id + 1 : 1;

  mtTexts.push({ id: newId, to_email, subject, body });
  writeDb(MT_FILE, mtTexts);
    
  await ctx.reply(`✅ MT ID **${newId}** berhasil ditambahkan.\nSubjek: ${subject}\nEmail Tujuan: ${to_email}`);
});

bot.command('setactivemt', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa mengatur MT aktif.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /setactivemt <id_mt>');
  }

  const id = parseInt(args[0]);
  const mtText = getMtTextById(id);

  if (!mtText) {
    return ctx.reply(`❌ MT ID ${id} tidak ditemukan.`);
  }

  const settings = readDb(SETTINGS_DB);
  settings.active_mt_id = id;
  writeDb(SETTINGS_DB, settings);

  await ctx.reply(`✅ Template banding aktif disetel ke **ID ${id}** (Subjek: ${mtText.subject})`);
});

bot.command('listmt', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa melihat daftar MT.');
  }

  const mtTexts = getMtTexts();
  const settings = readDb(SETTINGS_DB);
  const activeId = settings.active_mt_id;

  if (mtTexts.length === 0) {
    return ctx.reply('📋 Tidak ada template banding yang tersedia.');
  }

  let text = `📋 Daftar Template Banding:\n\n`;
  mtTexts.forEach(mt => {
    text += `ID: ${mt.id} ${mt.id === activeId ? '✅' : ''}\n`;
    text += `Subjek: ${mt.subject}\n`;
    text += `Email: ${mt.to_email}\n`;
    text += `---\n`;
  });

  await ctx.reply(text);
});

bot.command(['addprem', 'addpremium'], async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menambah premium user.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('❌ Format: /addprem <id_telegram> <durasi>\n\n📝 Contoh: /addprem 123456789 30d\n(s = detik, m = menit, h = jam, d = hari)');
  }

  const targetIdStr = args[0];
  const duration = args[1];

  const targetIdNum = parseInt(targetIdStr, 10);
  if (isNaN(targetIdNum)) {
      return ctx.reply('❌ ID Telegram tidak valid. Harap berikan ID pengguna berupa angka.');
  }

  const ms = toMs(duration);
  if (!ms) {
    return ctx.reply('❌ Format waktu tidak valid! Gunakan s/m/h/d.\nContoh: 30d, 1h, 10m');
  }

  const now = Date.now();
  let newExp;
  
  const premKey = String(targetIdNum);

  if (_prem[premKey] && _prem[premKey] > now) {
    newExp = _prem[premKey] + ms;
  } else {
    newExp = now + ms;
  }

  _prem[premKey] = newExp;
  try {
    fs.writeFileSync(premDBPath, JSON.stringify(_prem, null, 2));
  } catch (e) {
    console.error('Gagal simpan database premium:', e);
    return ctx.reply('❌ Gagal menyimpan data premium ke database.');
  }
 
  const user = getUser(targetIdNum);
  user.status = 'premium';
  saveUser(user);

  const expiredDate = formatWIB(newExp);
  await ctx.reply(
    `✅ SUKSES MENAMBAH PREMIUM\n\n` +
    `👤 ID: ${targetIdNum}\n` +
    `⏱️ Durasi: ${duration}\n` +
    `📅 Expired: ${expiredDate}\n` +
    `✨ User sekarang memiliki akses fitur premium.`
  );
});

bot.command(['delprem', 'delpremium'], async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menghapus premium user.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /delprem <id_telegram>');
  }

  const targetId = args[0];

  if (!_prem[targetId]) {
    return ctx.reply(`ℹ️ ID ${targetId} tidak terdaftar di database premium.`);
  }
  delete _prem[targetId];
  fs.writeFileSync(premDBPath, JSON.stringify(_prem, null, 2));

  const user = getUser(parseInt(targetId));
  user.status = 'free'; 
  saveUser(user);

  await ctx.reply(`✅ Premium untuk ID ${targetId} berhasil dihapus.`);
});

bot.command('cekprem', async (ctx) => {
    const targetId = ctx.message.from.id;
    
    if (_prem[targetId]) {
        const remainingTime = _prem[targetId] - Date.now();
        if (remainingTime > 0) {
            const expiredDate = formatWIB(_prem[targetId]);
            const daysLeft = Math.ceil(remainingTime / (1000 * 60 * 60 * 24));
            return ctx.reply(`✅ *STATUS: PREMIUM*\n\n📅 Berakhir pada: ${expiredDate}\n⏳ Sisa waktu: ${daysLeft} hari`, { parse_mode: 'Markdown' });
        }
    }
    
    return ctx.reply('❌ Anda bukan user Premium atau masa aktif sudah habis.');
});


bot.command('userinfo', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa melihat info user.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /userinfo <id_telegram>');
  }

  const targetId = parseInt(args[0]);
  const user = getUser(targetId);
  
  const info = `
👤 Detail User ID ${targetId}
Username: @${user.username}
Status: ${user.status.toUpperCase()}
Banned: ${user.is_banned ? 'YA' : 'TIDAK'}
Limit /fix: ${user.fix_limit}x
Poin Referral: ${user.referral_points}
Terakhir /fix: ${user.last_fix ? new Date(user.last_fix).toLocaleString('id-ID') : 'Belum pernah'}
  `;

  await ctx.reply(info);
});

bot.command('start', async (ctx) => {
  const userId = ctx.message.from.id;
  const user = getUser(userId);
  
  const isOwnerStatus = isOwner(userId);
  const isAdminStatus = isAdmin(userId) && !isOwnerStatus;
  const isPremium = user.status === 'premium';

  let text = `
*╭───── ⧼ INFO BOT ⧽
│Creator : @fazzhost2
│Version : 1.0
│Type : Case 
╰─────*
╭───── ⧼ STATUS USER ⧽
┃*Owner* : ${isOwnerStatus ? '✅' : '❌'}
┃*Admin* : ${isAdminStatus ? '✅' : '❌'}
┃*Premium* : ${isPremium ? '✅' : '❌'}
╰─────
 ═══════════[ MENU ]═══════════\n\n`;

  if (isAllowed(userId)) {
    text += `┃ /cekbio (nomor)\n`;
    text += `┃ /cekbiofile (reply file txt.csv.xlsx)\n`;
    text += `┃ /banding (nomor)\n`;
    text += `┃ /ceknomorterdaftar (daftar nomor)\n`;
    text += `┃ /cekrange (daftar nomor)\n`;
    text += `┃ /cekrepe (daftar nomor)\n`;
    text += `┃ /fix (nomor merah)\n\n`;
    
    if (isAdmin(userId)) {
      text += `══════════[ ADMIN ]══════════\n`;
      text += `┃ /addkacung (id)\n`;
      text += `┃ /addallkacung (id1 id2...)\n`;
      text += `┃ /listkacung\n\n`;
      
      if (isOwner(userId)) {
        text += `══════════[ OWNER ]══════════\n`;
        text += `┃ /delkacung (id)\n`;
        text += `┃ /addadmin (id)\n`;
        text += `┃ /unadmin (id)\n`;
        text += `┃ /listadmin\n`;
        text += `┃ /getqr\n`;
        text += `┃ /getpairing\n\n`;
      }
    }
  } else {
    text += `❌ Lu belum terverifikasi! Dongo \n`;
    text += `hubungi onwer untuk mendapatkan akses ke semua fitur bot:\n\n`;
    text += `${GROUP_LINK}\n\n`;
  }

  text += `💌 JANGAN LUPA SHOLAT 🫡 \n\n`;
  text += `© SHOLAT YA - OKE`;

  const keyboard = [];
  
  if (!isAllowed(userId)) {
    keyboard.push([
      { text: "✅ Join untuk Akses Bot", url: GROUP_LINK }
    ]);
    keyboard.push([
      { text: "🔍 Cek Verifikasi", callback_data: "check_verification" }
    ]);
  }

  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  };

  const typingMessage = await ctx.reply('🔄 Sedang memuat...');
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  
  setTimeout(async () => {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        typingMessage.message_id,
        null,
        text,
        options
      );
    } catch (error) {
      await ctx.reply(text, options);
    }
  }, 1000);
});

bot.action('check_verification', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Callback query sudah kadaluarsa, lanjutkan tanpa answer');
  }
  
  try {
    const chatMember = await ctx.telegram.getChatMember(VERIFICATION_GROUP_ID, userId);
    
    if (chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator') {
      if (!allowedIds.includes(userId)) {
        allowedIds.push(userId);
        saveAllowed();
        
        await ctx.reply('✅ Verifikasi berhasil! Kamu sekarang bisa menggunakan semua fitur bot.');
        
        try {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch (e) {
          console.log('Tidak bisa edit pesan:', e.message);
        }
      } else {
        await ctx.reply('✅ Kamu sudah terverifikasi sebelumnya.');
      }
    } else {
      await ctx.reply('❌ Kamu belum belum dapat akses. Silakan hubungi onwer terlebih dahulu lalu coba lagi.');
    }
  } catch (error) {
    console.error('Error cek verifikasi:', error);
    await ctx.reply('❌ Gagal memverifikasi. Pastikan kamu sudah join grup dan coba lagi.');
  }
});

bot.command('addadmin', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menambah admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /addadmin <id_telegram>');
  }
  
  const newAdminId = parseInt(args[0]);
  if (!adminIds.includes(newAdminId)) {
    adminIds.push(newAdminId);
    saveAdmin();
    await ctx.reply(`✅ ID ${newAdminId} berhasil ditambahkan sebagai admin.`);
  } else {
    await ctx.reply(`ℹ️ ID ${newAdminId} sudah menjadi admin.`);
  }
});

bot.command('unadmin', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menghapus admin.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /unadmin <id_telegram>');
  }
  
  const targetAdminId = parseInt(args[0]);
  if (adminIds.includes(targetAdminId)) {
    adminIds = adminIds.filter(id => id !== targetAdminId);
    saveAdmin();
    await ctx.reply(`✅ ID ${targetAdminId} berhasil dihapus dari admin.`);
  } else {
    await ctx.reply(`ℹ️ ID ${targetAdminId} bukan admin.`);
  }
});

bot.command('listadmin', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa melihat daftar admin.');
  }
  
  loadData();
  
  if (adminIds.length === 0) {
    return ctx.reply('📋 Tidak ada admin selain owner.');
  }
  
  let text = `📋 Daftar Admin:\n`;
  text += `👑 Owner: ${OWNER_ID}\n\n`;
  adminIds.forEach((id, idx) => {
    text += `${idx + 1}. ${id}\n`;
  });
  await ctx.reply(text);
});

bot.command('addkacung', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ Kamu tidak punya izin untuk menambah ID.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /addkacung <id_telegram>');
  }
  
  const newId = parseInt(args[0]);
  if (!allowedIds.includes(newId)) {
    allowedIds.push(newId);
    saveAllowed();
    await ctx.reply(`✅ ID ${newId} berhasil ditambahkan.`);
  } else {
    await ctx.reply(`ℹ️ ID ${newId} sudah ada di daftar.`);
  }
});

bot.command('addkacungall', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ Kamu tidak punya izin untuk menambah ID.');
  }
  
  const messageText = ctx.message.text;
  const args = messageText.replace('/addkacungall', '').trim().split(/[\s,\n]+/).filter(arg => arg.length > 0);
  
  if (args.length === 0) {
    return ctx.reply('❌ Format: /addkacungall <id1> <id2> ...');
  }
  
  const ids = args.map(id => parseInt(id)).filter(id => !isNaN(id));
  
  if (ids.length === 0) {
    return ctx.reply('❌ Tidak ada ID yang valid.');
  }
  
  let addedCount = 0;
  let alreadyCount = 0;
  
  for (const newId of ids) {
    if (!allowedIds.includes(newId)) {
      allowedIds.push(newId);
      addedCount++;
    } else {
      alreadyCount++;
    }
  }
  
  saveAllowed();
  await ctx.reply(`✅ ${addedCount} ID berhasil ditambahkan. ${alreadyCount} ID sudah ada.`);
});

bot.command('listkacungid', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ Kamu tidak punya izin melihat daftar ID.');
  }
  
  loadData();
  
  if (allowedIds.length === 0) {
    return ctx.reply('📋 Tidak ada ID yang diizinkan.');
  }
  
  let text = `📋 Daftar ID yang diizinkan (${allowedIds.length}):\n\n`;
  allowedIds.forEach((id, idx) => {
    text += `${idx + 1}. ${id}\n`;
  });
  
  if (text.length > 4096) {
    text = text.substring(0, 4090) + '...';
  }
  
  await ctx.reply(text);
});

bot.command('delkacung', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa menghapus ID.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('❌ Format: /delkacung <id_telegram>');
  }
  
  const targetId = parseInt(args[0]);
  if (allowedIds.includes(targetId)) {
    allowedIds = allowedIds.filter(id => id !== targetId);
    saveAllowed();
    await ctx.reply(`✅ ID ${targetId} berhasil dihapus.`);
  } else {
    await ctx.reply(`ℹ️ ID ${targetId} tidak berada di daftar.`);
  }
});

bot.command('cekbio', async (ctx) => {
  const chatId = ctx.message.chat.id;
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum dapat akses dari onwer! hubungi onwer untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  if (!isWhatsAppConnected || !whatsappSock) {
    return ctx.reply('❌ WhatsApp belum terhubung. Tunggu beberapa saat dan coba lagi.');
  }

  const messageText = ctx.message.text;
  const numbersText = messageText.replace('/cekbio', '').trim();
  const numbers = numbersText.split(/[\s,\n]+/).filter(num => num.length > 0);
  
  if (numbers.length === 0) {
    return ctx.reply(
      '❌ Format salah!\n\n' +
      '✅ Gunakan: `/cekbio nomor1 nomor2 nomor3`\n' +
      '📝 Contoh: `/cekbio 628××××× 628××××× 628×××××`\n\n' +
      '💡 *Note:* Maksimal 300 nomor per request',
      { parse_mode: 'Markdown' }
    );
  }

  const validNumbers = numbers.slice(0, 300).map(num => {
    let cleanNum = num.replace(/\D/g, '');
    if (cleanNum.startsWith('0')) {
      cleanNum = '62' + cleanNum.substring(1);
    } else if (cleanNum.startsWith('8')) {
      cleanNum = '62' + cleanNum;
    }
    return cleanNum;
  }).filter(num => num.length >= 10 && num.length <= 15);

  if (validNumbers.length === 0) {
    return ctx.reply('❌ Tidak ada nomor yang valid. Pastikan format nomor benar.');
  }

  try {
    await ctx.telegram.sendChatAction(chatId, 'typing');
    let progressMessage = await ctx.reply(`⏳ Memulai pengecekan 0/${validNumbers.length} nomor...`);
    let results = [];
    let processedCount = 0;

    const updateProgress = async (current, total, currentNumber = '') => {
      const progressBar = createProgressBar(current, total);
      const message = `⏳ ${progressBar} ${current.toString().padStart(5)}/${total}\n📱 Sedang memproses: ${currentNumber || '...'}\n📁 Sumber: Input Manual`;
      
      try {
        await ctx.telegram.editMessageText(
          chatId,
          progressMessage.message_id,
          null,
          message
        );
      } catch (error) {
      }
    };

    const batchSize = 20;
    
    for (let i = 0; i < validNumbers.length; i += batchSize) {
      const batch = validNumbers.slice(i, i + batchSize);
      const batchPromises = batch.map(async (num) => {
        try {
          const jid = num + "@s.whatsapp.net";
          
          const [waCheck] = await whatsappSock.onWhatsApp(jid);
          
          if (!waCheck || !waCheck.exists) {
            return {
              number: num,
              registered: false,
              bio: null,
              setAt: null,
              metaBusiness: false
            };
          }

          let bioData = null;
          let setAt = null;
          let metaBusiness = false;
          
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const statusResult = await whatsappSock.fetchStatus(jid);
            if (statusResult && statusResult[0] && statusResult[0].status) {
              bioData = statusResult[0].status.status || "";
              setAt = statusResult[0].status.setAt ? new Date(statusResult[0].status.setAt) : null;
            }
          } catch (bioError) {
            bioData = "";
          }

          try {
            const businessCheck = await checkMetaBusiness(jid);
            metaBusiness = businessCheck.isBusiness;
          } catch (businessError) {
            metaBusiness = false;
          }

          const jamPercentage = getJamPercentage(bioData, setAt, metaBusiness);

          return {
            number: num,
            registered: true,
            bio: bioData,
            setAt: setAt,
            metaBusiness: metaBusiness,
            jamPercentage: jamPercentage
          };
          
        } catch (error) {
          return {
            number: num,
            registered: false,
            bio: null,
            setAt: null,
            metaBusiness: false,
            error: true
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      processedCount += batch.length;
      
      await updateProgress(processedCount, validNumbers.length, batch[0]);
      
      if (i + batchSize < validNumbers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    await ctx.telegram.editMessageText(
      chatId,
      progressMessage.message_id,
      null,
      '📊 Menyusun hasil...'
    );

    const filename = createBioResultFile(results, validNumbers.length);
    
    await ctx.replyWithDocument(
      { source: filename },
      {
        caption: `📋 *HASIL CEK BIO WHATSAPP*\n\n` +
                `📊 Total: ${validNumbers.length} nomor\n` +
                `✅ Terdaftar: ${results.filter(r => r.registered).length}\n` +
                `❌ Tidak terdaftar: ${results.filter(r => !r.registered).length}\n` +
                `📝 Dengan bio: ${results.filter(r => r.registered && r.bio && r.bio.length > 0).length}\n` +
                `🏢 Meta Business: ${results.filter(r => r.metaBusiness).length}\n\n` +
                `🕒 ${new Date().toLocaleString('id-ID')}`,
        parse_mode: 'Markdown'
      }
    );

    setTimeout(() => {
      try {
        fs.unlinkSync(filename);
      } catch (e) {
        console.log('Gagal menghapus file temporary:', e.message);
      }
    }, 5000);

    try {
      await ctx.telegram.deleteMessage(chatId, progressMessage.message_id);
    } catch (e) {}
  } catch (error) {
    console.error('Error dalam command cekbio:', error);
    ctx.reply('❌ Terjadi kesalahan sistem. Coba lagi beberapa saat.');
  }
});

bot.command('cekbiofile', async (ctx) => {
  const chatId = ctx.message.chat.id;
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum terverifikasi! Join grup via tombol di /start untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  if (!isWhatsAppConnected || !whatsappSock) {
    return ctx.reply('❌ WhatsApp belum terhubung. Tunggu beberapa saat dan coba lagi.');
  }

  if (!ctx.message.reply_to_message) {
    return ctx.reply(
      '❌ Format salah!\n\n' +
      '✅ Gunakan: Reply file TXT/CSV/XLSX dengan command `/cekbiofile`\n' +
      '📝 Contoh: Kirim file berisi nomor, lalu reply file tersebut dengan `/cekbiofile`\n\n' +
      '💡 *Note:* Mendukung format TXT, CSV, dan XLSX\n' +
      '💡 *Fitur:* Tidak ada batasan jumlah nomor',
      { parse_mode: 'Markdown' }
    );
  }

  const repliedMessage = ctx.message.reply_to_message;

  if (!repliedMessage.document) {
    return ctx.reply('❌ Harap reply ke file TXT/CSV/XLSX yang berisi daftar nomor.');
  }

  const fileName = repliedMessage.document.file_name || '';
  const supportedFormats = ['txt', 'csv', 'xlsx'];
  const fileExtension = fileName.toLowerCase().split('.').pop();

  if (!supportedFormats.includes(fileExtension)) {
    return ctx.reply('❌ Format file tidak didukung. Gunakan file TXT, CSV, atau XLSX.');
  }

  try {
    await ctx.telegram.sendChatAction(chatId, 'typing');
    
    const fileBuffer = await downloadTelegramFile(repliedMessage.document.file_id, fileName);
    
    const numbers = await processFile(fileBuffer, fileName);
    
    if (numbers.length === 0) {
      return ctx.reply('❌ File tidak berisi nomor yang valid.');
    }

    const validNumbers = numbers.map(num => {
      let cleanNum = num.replace(/\D/g, '');
      if (cleanNum.startsWith('0')) {
        cleanNum = '62' + cleanNum.substring(1);
      } else if (cleanNum.startsWith('8')) {
        cleanNum = '62' + cleanNum;
      }
      return cleanNum;
    }).filter(num => num.length >= 10 && num.length <= 15);

    if (validNumbers.length === 0) {
      return ctx.reply('❌ Tidak ada nomor yang valid dalam file.');
    }

    if (validNumbers.length > 1000) {
      await ctx.reply(`⚠️ Peringatan: Anda akan memproses ${validNumbers.length} nomor. Proses mungkin memakan waktu lama.`);
    }

    let progressMessage = await ctx.reply(`⏳ Memulai pengecekan 0/${validNumbers.length} nomor...`);
    let results = [];
    let processedCount = 0;

    const fileSourceType = getFileSourceType(fileName);

    const updateProgress = async (current, total, currentNumber = '') => {
      const progressBar = createProgressBar(current, total);
      const message = `⏳ ${progressBar} ${current.toString().padStart(5)}/${total}\n📱 Sedang memproses: ${currentNumber || '...'}\n📁 Sumber: ${fileSourceType}`;
      
      try {
        await ctx.telegram.editMessageText(
          chatId,
          progressMessage.message_id,
          null,
          message
        );
      } catch (error) {
      }
    };

    const batchSize = 20;
    
    for (let i = 0; i < validNumbers.length; i += batchSize) {
      const batch = validNumbers.slice(i, i + batchSize);
      const batchPromises = batch.map(async (num) => {
        try {
          const jid = num + "@s.whatsapp.net";
          
          const [waCheck] = await whatsappSock.onWhatsApp(jid);
          
          if (!waCheck || !waCheck.exists) {
            return {
              number: num,
              registered: false,
              bio: null,
              setAt: null,
              metaBusiness: false
            };
          }

          let bioData = null;
          let setAt = null;
          let metaBusiness = false;
          
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const statusResult = await whatsappSock.fetchStatus(jid);
            if (statusResult && statusResult[0] && statusResult[0].status) {
              bioData = statusResult[0].status.status || "";
              setAt = statusResult[0].status.setAt ? new Date(statusResult[0].status.setAt) : null;
            }
          } catch (bioError) {
            bioData = "";
          }

          try {
            const businessCheck = await checkMetaBusiness(jid);
            metaBusiness = businessCheck.isBusiness;
          } catch (businessError) {
            metaBusiness = false;
          }

          const jamPercentage = getJamPercentage(bioData, setAt, metaBusiness);

          return {
            number: num,
            registered: true,
            bio: bioData,
            setAt: setAt,
            metaBusiness: metaBusiness,
            jamPercentage: jamPercentage
          };
          
        } catch (error) {
          return {
            number: num,
            registered: false,
            bio: null,
            setAt: null,
            metaBusiness: false,
            error: true
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      processedCount += batch.length;
      
      await updateProgress(processedCount, validNumbers.length, batch[0]);
      
      if (i + batchSize < validNumbers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    await ctx.telegram.editMessageText(
      chatId,
      progressMessage.message_id,
      null,
      '📊 Menyusun hasil...'
    );

    const filename = createBioResultFile(results, validNumbers.length, fileSourceType);
    
    await ctx.replyWithDocument(
      { source: filename },
      {
        caption: `📋 *HASIL CEK BIO WHATSAPP DARI ${fileSourceType.toUpperCase()}*\n\n` +
                `📊 Total: ${validNumbers.length} nomor\n` +
                `✅ Terdaftar: ${results.filter(r => r.registered).length}\n` +
                `❌ Tidak terdaftar: ${results.filter(r => !r.registered).length}\n` +
                `📝 Dengan bio: ${results.filter(r => r.registered && r.bio && r.bio.length > 0).length}\n` +
                `🏢 Meta Business: ${results.filter(r => r.metaBusiness).length}\n\n` +
                `📁 File: ${fileName}\n` +
                `🕒 ${new Date().toLocaleString('id-ID')}`,
        parse_mode: 'Markdown'
      }
    );

    setTimeout(() => {
      try {
        fs.unlinkSync(filename);
      } catch (e) {
        console.log('Gagal menghapus file temporary:', e.message);
      }
    }, 5000);

    try {
      await ctx.telegram.deleteMessage(chatId, progressMessage.message_id);
    } catch (e) {}
  } catch (error) {
    console.error('Error dalam command cekbiofile:', error);
    ctx.reply(`❌ Terjadi kesalahan sistem: ${error.message}. Pastikan file berisi nomor yang valid dan coba lagi.`);
  }
});

bot.command('restart', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!isOwner(userId)) {
    return ctx.reply('❌ Hanya owner yang bisa melakukan restart server.');
  }

  try {
    await ctx.reply(
      '🔄 *SYSTEM RESTARTING...*\n\n' +
      'Bot akan dimatikan dan dinyalakan ulang otomatis.\n' +
      'Estimasi waktu kembali online: 5-10 detik.',
      { parse_mode: 'Markdown' }
    );

    console.log(`[RESTART] Perintah restart dijalankan oleh Owner ID: ${userId}`);
    if (whatsappSock) {
        try {
            whatsappSock.end(undefined); 
        } catch (e) {
            console.error('Error saat menutup koneksi WA:', e);
        }
    }
   setTimeout(() => {
        console.log('🛑 Mematikan proses untuk restart...');
        process.exit(0); 
    }, 1000);

  } catch (error) {
    console.error('❌ Error saat mencoba restart:', error);
    ctx.reply('❌ Gagal melakukan restart sistem.');
  }
});

bot.command('ceknomorterdaftar', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum dapat akses dari onwer! hubungi onwer untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  if (!isWhatsAppConnected || !whatsappSock) {
    return ctx.reply('❌ WhatsApp belum terhubung. Tunggu beberapa saat dan coba lagi.');
  }

  const messageText = ctx.message.text;
  const numbersText = messageText.replace('/ceknomorterdaftar', '').trim();
  const numbers = numbersText.split(/[\s,\n]+/).filter(num => num.length > 0);
  
  if (numbers.length === 0) {
    return ctx.reply('❌ Format: /ceknomorterdaftar <nomor1> <nomor2> ...\n\n💡 Maksimal 300 nomor per request');
  }

  const validNumbers = numbers.slice(0, 300).map(num => {
    let cleanNum = num.replace(/\D/g, '');
    if (cleanNum.startsWith('0')) {
      cleanNum = '62' + cleanNum.substring(1);
    } else if (cleanNum.startsWith('8')) {
      cleanNum = '62' + cleanNum;
    }
    return cleanNum;
  }).filter(num => num.length >= 10 && num.length <= 15);

  if (validNumbers.length === 0) {
    return ctx.reply('❌ Tidak ada nomor yang valid.');
  }

  try {
    await ctx.telegram.sendChatAction(ctx.message.chat.id, 'typing');
    
    const progressMessage = await ctx.reply(`⏳ Memulai pengecekan status 0/${validNumbers.length} nomor...`);
    let registered = [];
    let notRegistered = [];

    const batchSize = 20;
    
    for (let i = 0; i < validNumbers.length; i += batchSize) {
      const batch = validNumbers.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (num) => {
        try {
          const jid = num + "@s.whatsapp.net";
          const [waCheck] = await whatsappSock.onWhatsApp(jid);
          
          if (waCheck && waCheck.exists) {
            return { num, status: 'registered' };
          } else {
            return { num, status: 'not_registered' };
          }
        } catch (e) {
          return { num, status: 'error' };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'registered') {
          registered.push(result.num);
        } else {
          notRegistered.push(result.num);
        }
      });

      const processed = Math.min(i + batchSize, validNumbers.length);
      try {
        await ctx.telegram.editMessageText(
          ctx.message.chat.id,
          progressMessage.message_id,
          null,
          `⏳ Memeriksa ${processed}/${validNumbers.length} nomor...`
        );
      } catch (e) {}

      if (i + batchSize < validNumbers.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    let fileContent = `📊 Hasil cek status ${validNumbers.length} nomor\n\n`;

    if (registered.length) {
      fileContent += `✅ Terdaftar (${registered.length}):\n`;
      registered.forEach((num, idx) => {
        fileContent += `${idx + 1}. ${num}\n`;
      });
      fileContent += `\n`;
    }

    if (notRegistered.length) {
      fileContent += `❌ Tidak terdaftar (${notRegistered.length}):\n`;
      notRegistered.forEach((num, idx) => {
        fileContent += `${idx + 1}. ${num}\n`;
      });
    }

    const filename = `status_result_${Date.now()}.txt`;
    fs.writeFileSync(filename, fileContent);

    await ctx.replyWithDocument(
      { source: filename },
      { caption: `📊 Hasil pengecekan status ${validNumbers.length} nomor selesai!` }
    );
    
    try {
      await ctx.telegram.deleteMessage(ctx.message.chat.id, progressMessage.message_id);
    } catch (e) {}
    
    fs.unlinkSync(filename);
  } catch (error) {
    console.error('Error dalam command ceknomorterdaftar:', error);
    ctx.reply('❌ Terjadi kesalahan sistem.');
  }
});

bot.command('cekrange', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum dapat akses dari onweri! hubungi onwer untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  if (!isWhatsAppConnected || !whatsappSock) {
    return ctx.reply('❌ WhatsApp belum terhubung. Tunggu beberapa saat dan coba lagi.');
  }

  const messageText = ctx.message.text;
  const args = messageText.replace('/cekrange', '').trim().split(/\s+/);
  
  if (args.length < 3) {
    return ctx.reply(
      '❌ Format: /cekrange <prefix> <start> <end>\n\n' +
      '📝 Contoh: `/cekrange 628 1234 1250`\n' +
      '💡 *Note:* Prefix akan digabung dengan angka range\n' +
      '💡 Maksimal 300 nomor per request',
      { parse_mode: 'Markdown' }
    );
  }

  const prefix = args[0];
  const start = parseInt(args[1]);
  const end = parseInt(args[2]);

  if (isNaN(start) || isNaN(end)) {
    return ctx.reply('❌ Start dan end harus berupa angka.');
  }

  const range = end - start + 1;
  if (range > 300) {
    return ctx.reply(`❌ Range terlalu besar. Maksimal 300 nomor, kamu meminta ${range} nomor.`);
  }

  if (range <= 0) {
    return ctx.reply('❌ Range tidak valid. End harus lebih besar dari start.');
  }

  let cleanPrefix = prefix.replace(/\D/g, '');
  if (cleanPrefix.startsWith('0')) {
    cleanPrefix = '62' + cleanPrefix.substring(1);
  } else if (cleanPrefix.startsWith('8')) {
    cleanPrefix = '62' + cleanPrefix;
  }

  const numbers = [];
  for (let i = start; i <= end; i++) {
    numbers.push(cleanPrefix + i);
  }

  try {
    await ctx.telegram.sendChatAction(ctx.message.chat.id, 'typing');
    
    const progressMessage = await ctx.reply(`⏳ Memulai pengecekan range 0/${numbers.length} nomor...`);
    let registered = [];
    let notRegistered = [];

    const batchSize = 20;
    
    for (let i = 0; i < numbers.length; i += batchSize) {
      const batch = numbers.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (num) => {
        try {
          const jid = num + "@s.whatsapp.net";
          const [waCheck] = await whatsappSock.onWhatsApp(jid);
          
          if (waCheck && waCheck.exists) {
            return { num, status: 'registered' };
          } else {
            return { num, status: 'not_registered' };
          }
        } catch (e) {
          return { num, status: 'error' };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'registered') {
          registered.push(result.num);
        } else {
          notRegistered.push(result.num);
        }
      });

      const processed = Math.min(i + batchSize, numbers.length);
      try {
        await ctx.telegram.editMessageText(
          ctx.message.chat.id,
          progressMessage.message_id,
          null,
          `⏳ Memeriksa ${processed}/${numbers.length} nomor...`
        );
      } catch (e) {}

      if (i + batchSize < numbers.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    let fileContent = `📊 Hasil cek range ${numbers.length} nomor\n\n`;
    fileContent += `Prefix: ${prefix}\n`;
    fileContent += `Range: ${start} - ${end}\n`;
    fileContent += `Prefix Clean: ${cleanPrefix}\n\n`;

    if (registered.length) {
      fileContent += `✅ Terdaftar (${registered.length}):\n`;
      registered.forEach((num, idx) => {
        fileContent += `${idx + 1}. ${num}\n`;
      });
      fileContent += `\n`;
    }

    if (notRegistered.length) {
      fileContent += `❌ Tidak terdaftar (${notRegistered.length}):\n`;
      notRegistered.forEach((num, idx) => {
        fileContent += `${idx + 1}. ${num}\n`;
      });
    }

    const filename = `range_result_${Date.now()}.txt`;
    fs.writeFileSync(filename, fileContent);

    await ctx.replyWithDocument(
      { source: filename },
      { 
        caption: `📊 Hasil pengecekan range ${start}-${end} selesai!\n` +
                `✅ Terdaftar: ${registered.length}\n` +
                `❌ Tidak terdaftar: ${notRegistered.length}\n` +
                `🔢 Prefix: ${cleanPrefix}`
      }
    );
    
    try {
      await ctx.telegram.deleteMessage(ctx.message.chat.id, progressMessage.message_id);
    } catch (e) {}
    
    fs.unlinkSync(filename);
  } catch (error) {
    console.error('Error dalam command cekrange:', error);
    ctx.reply('❌ Terjadi kesalahan sistem.');
  }
});

bot.command('banding', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum dapat akses dari onwer! hubungi onwer untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  const messageText = ctx.message.text;
  const args = messageText.replace('/banding', '').trim().split(/\s+/);
  
  if (args.length === 0 || !args[0]) {
    return ctx.reply('❌ Format: /banding <nomor_whatsapp>\n\n📝 Contoh: `/banding 628123456789`', { parse_mode: 'Markdown' });
  }

  let number = args[0].replace(/\D/g, '');
  if (number.startsWith('0')) {
    number = '62' + number.substring(1);
  } else if (number.startsWith('8')) {
    number = '62' + number;
  }

  if (number.length < 10 || number.length > 15) {
    return ctx.reply('❌ Format nomor tidak valid.');
  }

  await ctx.telegram.sendChatAction(ctx.message.chat.id, 'typing');
  
  const randomName = getRandomName();
  const appealMessage = getRandomAppealMessage(randomName, number);
  const percentage = getVerificationPercentage(number);

  const resultText = 
    `📋 *HASIL BANDING WHATSAPP*\n\n` +
    `📱 Nomor: +${number}\n` +
    `👤 Nama: ${randomName}\n` +
    `📊 Persentase Verifikasi: ${percentage}%\n\n` +
    `📝 *Pesan Banding:*\n${appealMessage}\n\n` +
    `📧 *Email WhatsApp:*\n${WHATSAPP_EMAIL}\n\n` +
    `💡 *Tips:* Kirim pesan di atas ke email WhatsApp untuk proses banding.`;

  await ctx.reply(resultText, { parse_mode: 'Markdown' });
});

bot.command('cekrepe', async (ctx) => {
  const userId = ctx.message.from.id;
  
  if (!isAllowed(userId)) {
    return ctx.reply('❌ Kamu belum dapat akses dari onwer! hubungi onwer untuk menggunakan bot.');
  }

  const cooldown = checkCooldown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(`⏰ Kamu harus menunggu ${cooldown.remaining} detik sebelum bisa menggunakan fitur ini lagi.`);
  }

  if (!isWhatsAppConnected || !whatsappSock) {
    return ctx.reply('❌ WhatsApp belum terhubung. Tunggu beberapa saat dan coba lagi.');
  }

  const messageText = ctx.message.text;
  const numbersText = messageText.replace('/cekrepe', '').trim();
  const numbers = numbersText.split(/[\s,\n]+/).filter(num => num.length > 0);
  
  if (numbers.length === 0) {
    return ctx.reply('❌ Format: /cekrepe <nomor1> <nomor2> ...\n\n💡 Maksimal 300 nomor per request');
  }

  const validNumbers = numbers.slice(0, 300).map(num => {
    let cleanNum = num.replace(/\D/g, '');
    if (cleanNum.startsWith('0')) {
      cleanNum = '62' + cleanNum.substring(1);
    } else if (cleanNum.startsWith('8')) {
      cleanNum = '62' + cleanNum;
    }
    return cleanNum;
  }).filter(num => num.length >= 10 && num.length <= 15);

  if (validNumbers.length === 0) {
    return ctx.reply('❌ Tidak ada nomor yang valid.');
  }

  try {
    await ctx.telegram.sendChatAction(ctx.message.chat.id, 'typing');
    
    const progressMessage = await ctx.reply(`⏳ Memulai pengecekan nokos repe 0/${validNumbers.length} nomor...`);
    
    const registeredRepe = [];
    const notRegisteredRepe = [];
    const notRepeNumbers = {
      registered: [],
      notRegistered: []
    };

    const batchSize = 20;
    
    for (let i = 0; i < validNumbers.length; i += batchSize) {
      const batch = validNumbers.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (num) => {
        try {
          const jid = num + "@s.whatsapp.net";
          const [waCheck] = await whatsappSock.onWhatsApp(jid);
          const isRepe = isRepeNumber(num);
          
          if (waCheck && waCheck.exists) {
            if (isRepe) {
              return { num, status: 'registered_repe', repe: true };
            } else {
              return { num, status: 'registered_normal', repe: false };
            }
          } else {
            if (isRepe) {
              return { num, status: 'not_registered_repe', repe: true };
            } else {
              return { num, status: 'not_registered_normal', repe: false };
            }
          }
        } catch (e) {
          return { num, status: 'error', repe: false };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'registered_repe') {
          registeredRepe.push({ number: result.num, percentage: getVerificationPercentage(result.num) });
        } else if (result.status === 'not_registered_repe') {
          notRegisteredRepe.push(result.num);
        } else if (result.status === 'registered_normal') {
          notRepeNumbers.registered.push(result.num);
        } else if (result.status === 'not_registered_normal') {
          notRepeNumbers.notRegistered.push(result.num);
        }
      });

      const processed = Math.min(i + batchSize, validNumbers.length);
      try {
        await ctx.telegram.editMessageText(
          ctx.message.chat.id,
          progressMessage.message_id,
          null,
          `⏳ Memeriksa ${processed}/${validNumbers.length} nomor...`
        );
      } catch (e) {}

      if (i + batchSize < validNumbers.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const filename = createRepeResultFile(registeredRepe, notRegisteredRepe, notRepeNumbers);

    await ctx.replyWithDocument(
      { source: filename },
      {
        caption: `📋 *HASIL CEK NOKOS REPE*\n\n` +
                `📊 Total: ${validNumbers.length} nomor\n` +
                `🔢 Nokos Repe Terdaftar: ${registeredRepe.length}\n` +
                `🔢 Nokos Repe Tidak Terdaftar: ${notRegisteredRepe.length}\n` +
                `📱 Nomor Biasa Terdaftar: ${notRepeNumbers.registered.length}\n` +
                `📱 Nomor Biasa Tidak Terdaftar: ${notRepeNumbers.notRegistered.length}\n\n` +
                `🕒 ${new Date().toLocaleString('id-ID')}`,
        parse_mode: 'Markdown'
      }
    );

    try {
      await ctx.telegram.deleteMessage(ctx.message.chat.id, progressMessage.message_id);
    } catch (e) {}
    
    setTimeout(() => {
      try {
        fs.unlinkSync(filename);
      } catch (e) {
        console.log('Gagal menghapus file temporary:', e.message);
      }
    }, 5000);

  } catch (error) {
    console.error('Error dalam command cekrepe:', error);
    ctx.reply('❌ Terjadi kesalahan sistem.');
  }
});

bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.message.chat.id;
  const newMembers = ctx.message.new_chat_members;

  if (chatId === VERIFICATION_GROUP_ID) {
    for (const member of newMembers) {
      const memberId = member.id;
      if (!allowedIds.includes(memberId) && !isAdmin(memberId)) {
        allowedIds.push(memberId);
        saveAllowed();
        
        try {
          await ctx.reply(
            `Selamat datang @${member.username || member.first_name}! 🎉\n` +
            `Kamu sekarang sudah terverifikasi dan bisa menggunakan semua fitur bot.`
          );
        } catch (e) {
          console.error('Gagal kirim pesan welcome:', e);
        }
      }
    }
  }
});

bot.catch((error, ctx) => {
  console.error('❌ Error Telegram Bot:', error);
  try {
    ctx.reply('❌ Terjadi kesalahan sistem. Silakan coba lagi.').catch(e => {
      console.error('Gagal kirim pesan error:', e);
    });
  } catch (e) {
  }
});

async function startAll() {
  try {
    console.log('🚀 Starting Telegram + WhatsApp Bot...');
    
    initAllDb();
    
    loadData();
    
    startWhatsAppManager().catch(error => {
      console.error('Gagal start WhatsApp Manager:', error);
    });
    
    await bot.launch();
    console.log('✅ Telegram Bot berhasil dijalankan');
    
    try {
      await bot.telegram.sendMessage(
        OWNER_ID,
        `🤖 *BOT ACTIVE* ✅✅\n\n` +
        `📅 Tanggal: ${new Date().toLocaleString('id-ID')}\n` +
        `⚡ Status: Online dan siap digunakan\n\n` +
        `ID ${OWNER_ID} boleh akses semua bot yang sedang Active.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Gagal kirim notifikasi ke owner:', error);
    }
    
    console.log('\n📋 BOT INFORMATION:');
    console.log('• WhatsApp: ' + (isWhatsAppConnected ? 'Connected' : 'Connecting...'));
    console.log('• Telegram: Connected');
    console.log('• Owner ID:', OWNER_ID);
    console.log('• Admin Count:', adminIds.length);
    console.log('• Allowed Users:', allowedIds.length);
    console.log('• Cooldown: 1000 detik GLOBAL untuk semua command');
    console.log('• Max Numbers: 300 per command (kecuali /cekbiofile)');
    console.log('• Fitur Baru: /fix (banding WhatsApp dengan template MT)');
    console.log('• Fitur Baru: Meta Business & Persentase Jam di /cekbio & /cekbiofile');
    console.log('• Auto-reconnect: Aktif');
    console.log('• QR Code System: WhatsApp Web JS Style');
    console.log('• Pairing Code System: Support semua negara');
    console.log('• File Support: TXT, CSV, XLSX untuk /cekbiofile');
    console.log('• Batch Size: 20 untuk semua command');
    console.log('• Gunakan /start di bot Telegram untuk mulai');
    
  } catch (error) {
    console.error('❌ Gagal memulai bot:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stop();
  if (whatsappSock) whatsappSock.end();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Shutting down bot...');
  bot.stop();
  if (whatsappSock) whatsappSock.end();
  process.exit(0);
});

startAll();