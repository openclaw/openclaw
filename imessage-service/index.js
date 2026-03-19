const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 3008;
const POLL_INTERVAL_MS = 1000;
const SQLITE_TIMEOUT_MS = 10000;
const APPLESCRIPT_TIMEOUT_MS = 60000;
const LOG_PREFIX = '[imessage-service]';
const RECORD_SEPARATOR = String.fromCharCode(30);
const FIELD_SEPARATOR = String.fromCharCode(31);
const HOME_DIR = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME_DIR, '.openclaw', 'workspace', 'imessage');
const REQUEST_FILE = path.join(DATA_DIR, 'imessage-request.json');
const RESPONSE_FILE = path.join(DATA_DIR, 'imessage-response.json');
const CHAT_DB = path.join(HOME_DIR, 'Library', 'Messages', 'chat.db');
const ADDRESS_BOOK_DIR = path.join(HOME_DIR, 'Library', 'Application Support', 'AddressBook');
const DEFAULT_ADDRESS_BOOK_PATH = path.join(ADDRESS_BOOK_DIR, 'AddressBook-v22.abcddb');
const PHONE_DIGITS_SQL = [
  "replace(",
  "replace(",
  "replace(",
  "replace(",
  "replace(",
  "replace(lower(h.id), '+', ''),",
  "'-', ''),",
  "'(', ''),",
  "')', ''),",
  "' ', ''),",
  "'.', '')"
].join('');
const PHONE_SQL_NORMALIZER = `CASE WHEN length(${PHONE_DIGITS_SQL}) = 10 THEN '1' || ${PHONE_DIGITS_SQL} ELSE ${PHONE_DIGITS_SQL} END`;

let lastProcessedMtimeMs = 0;
let isProcessing = false;
let hasPendingRun = false;

let contactsByPhone = new Map();
let contactsByEmail = new Map();
let contactsByName = new Map();
let contactEntries = [];
let contactsLoadedAt = null;
let contactsLoadError = null;
let contactsLoadPromise = null;
let addressBookPaths = null;

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

function writeResponse(payload) {
  const tempFile = RESPONSE_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tempFile, RESPONSE_FILE);
}

function successResponse(action, data) {
  return {
    success: true,
    action,
    data,
    responded_at: new Date().toISOString()
  };
}

function errorResponse(action, error) {
  const payload = {
    success: false,
    action: action || null,
    error: error instanceof Error ? error.message : String(error),
    responded_at: new Date().toISOString()
  };

  if (error && typeof error === 'object') {
    if (error.code) payload.code = error.code;
    if (Array.isArray(error.matches)) payload.matches = error.matches;
  }

  return payload;
}

function createServiceError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function runAppleScript(scriptLines, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || APPLESCRIPT_TIMEOUT_MS;
  const commandArgs = [];

  for (const line of scriptLines) {
    commandArgs.push('-e', line);
  }

  for (const arg of args) {
    commandArgs.push(String(arg));
  }

  return new Promise((resolve, reject) => {
    execFile('osascript', commandArgs, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr && stderr.trim()
          ? stderr.trim()
          : err.killed
            ? `AppleScript timed out after ${timeoutMs}ms`
            : err.message || 'AppleScript failed';
        reject(new Error(message.trim()));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function queryChatDb(sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', [CHAT_DB, '-json', sql], { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || 'sqlite3 failed').trim()));
        return;
      }

      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (parseError) {
        reject(new Error(`Failed to parse sqlite3 output: ${parseError.message}`));
      }
    });
  });
}

function queryJsonDb(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', [dbPath, '-json', sql], { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || 'sqlite3 failed').trim()));
        return;
      }

      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (parseError) {
        reject(new Error(`Failed to parse sqlite3 output: ${parseError.message}`));
      }
    });
  });
}

async function resolveAddressBookPaths() {
  if (Array.isArray(addressBookPaths) && addressBookPaths.length > 0) {
    return addressBookPaths;
  }

  const foundPath = await new Promise((resolve, reject) => {
    execFile(
      'find',
      [ADDRESS_BOOK_DIR, '-name', 'AddressBook-v22.abcddb'],
      { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'find failed').trim()));
          return;
        }
        const matches = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(matches);
      }
    );
  });

  const candidates = [];
  if (fs.existsSync(DEFAULT_ADDRESS_BOOK_PATH)) {
    candidates.push(DEFAULT_ADDRESS_BOOK_PATH);
  }
  for (const match of foundPath) {
    if (!candidates.includes(match)) {
      candidates.push(match);
    }
  }

  if (candidates.length === 0) {
    throw new Error('AddressBook-v22.abcddb not found');
  }

  addressBookPaths = candidates;
  return addressBookPaths;
}

function sendMessageScript() {
  return [
    'on run argv',
    '  set targetHandle to item 1 of argv',
    '  set messageText to item 2 of argv',
    '  tell application "Messages"',
    '    set targetService to 1st service whose service type = iMessage',
    '    set targetBuddy to buddy targetHandle of targetService',
    '    send messageText to targetBuddy',
    '  end tell',
    'end run'
  ];
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isEmailHandle(value) {
  return collapseWhitespace(value).includes('@');
}

function normalizeEmail(value) {
  return collapseWhitespace(value).toLowerCase();
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let digits = normalizePhoneDigits(value);
  if (digits.length === 10) digits = `1${digits}`;
  return digits;
}

function getPhoneLookupKeys(value) {
  const canonical = normalizePhone(value);
  if (!canonical) return [];
  return [canonical];
}

function sqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function escapeSqlLike(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/'/g, "''");
}

function clampLimit(value, defaultLimit, maxLimit) {
  if (value === undefined || value === null || value === '') {
    return defaultLimit;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('limit must be a positive integer');
  }

  return Math.min(parsed, maxLimit);
}

function previewText(value, maxLength = 120) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

function cocoaToDate(cocoaTimestamp) {
  const APPLE_EPOCH_OFFSET = 978307200;
  const unixSeconds = (Number(cocoaTimestamp || 0) / 1000000000) + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

function extractTextFromBody(hexStr) {
  if (!hexStr) return '';
  try {
    const buf = Buffer.from(hexStr, 'hex');
    const marker = Buffer.from('NSString');
    const idx = buf.indexOf(marker);
    if (idx === -1) return '';

    let pos = idx + marker.length;
    while (pos < buf.length - 2 && buf[pos] !== 0x2B) pos++;
    if (pos >= buf.length - 2) return '';

    pos++; // skip '+'
    const len = buf[pos];
    pos++;

    if (len === 0 || pos + len > buf.length) return '';
    return buf.slice(pos, pos + len).toString('utf8');
  } catch {
    return '';
  }
}

function addMapEntry(map, key, entry) {
  if (!key) return;

  const existing = map.get(key) || [];
  if (!existing.some((item) => item.identityKey === entry.identityKey)) {
    existing.push(entry);
  }
  map.set(key, existing);
}

function uniqueEntries(entries) {
  const seen = new Set();
  const output = [];

  for (const entry of entries) {
    if (!entry || seen.has(entry.identityKey)) continue;
    seen.add(entry.identityKey);
    output.push(entry);
  }

  return output;
}

function formatContactEntry(entry) {
  return {
    name: entry.name,
    phone: entry.phone
  };
}

function sortContactEntries(entries) {
  return entries.slice().sort((left, right) => {
    return left.name.localeCompare(right.name) || left.phone.localeCompare(right.phone);
  });
}

async function loadContacts() {
  if (contactsLoadPromise) {
    return contactsLoadPromise;
  }

  contactsLoadPromise = (async () => {
    const dbPaths = await resolveAddressBookPaths();
    const query = [
      'SELECT',
      '  ZABCDRECORD.ZFIRSTNAME as first_name,',
      '  ZABCDRECORD.ZLASTNAME as last_name,',
      '  ZABCDPHONENUMBER.ZFULLNUMBER as phone',
      'FROM ZABCDRECORD',
      'LEFT JOIN ZABCDPHONENUMBER ON ZABCDRECORD.Z_PK = ZABCDPHONENUMBER.ZOWNER',
      'WHERE ZABCDPHONENUMBER.ZFULLNUMBER IS NOT NULL'
    ].join(' ');
    const rowSets = await Promise.all(dbPaths.map((dbPath) => queryJsonDb(dbPath, query)));
    const nextByPhone = new Map();
    const nextByEmail = new Map();
    const nextByName = new Map();
    const nextEntries = [];
    const seenIdentities = new Set();

    for (const rows of rowSets) {
      for (const row of rows) {
        const rawName = collapseWhitespace(`${row.first_name || ''} ${row.last_name || ''}`);
        const rawHandle = collapseWhitespace(row.phone || '');
        if (!rawHandle) continue;

        const name = rawName || rawHandle;
        const canonicalHandle = getPhoneLookupKeys(rawHandle)[0];

        if (!canonicalHandle) continue;

        const entry = {
          name,
          phone: rawHandle,
          type: 'phone',
          canonicalHandle,
          identityKey: `phone:${canonicalHandle}:${name.toLowerCase()}`
        };

        if (seenIdentities.has(entry.identityKey)) {
          continue;
        }

        seenIdentities.add(entry.identityKey);
        nextEntries.push(entry);
        addMapEntry(nextByName, name.toLowerCase(), entry);

        for (const key of getPhoneLookupKeys(rawHandle)) {
          addMapEntry(nextByPhone, key, entry);
        }
      }
    }

    contactEntries = sortContactEntries(nextEntries);
    contactsByPhone = nextByPhone;
    contactsByEmail = nextByEmail;
    contactsByName = nextByName;
    contactsLoadedAt = new Date().toISOString();
    contactsLoadError = null;

    const uniqueNames = new Set(contactEntries.map((entry) => entry.name.toLowerCase())).size;
    log(`loaded ${contactEntries.length} contact handles across ${uniqueNames} contacts`);

    return {
      handles: contactEntries.length,
      contacts: uniqueNames,
      loaded_at: contactsLoadedAt
    };
  })();

  try {
    return await contactsLoadPromise;
  } finally {
    contactsLoadPromise = null;
  }
}

async function ensureContactsLoaded() {
  if (contactsLoadedAt || contactsLoadError || contactEntries.length > 0) {
    return;
  }

  try {
    await loadContacts();
  } catch (error) {
    contactsLoadError = error.message;
    throw error;
  }
}

function ensureContactsReady() {
  if (contactEntries.length > 0) {
    return;
  }

  if (contactsLoadError) {
    throw createServiceError(`Contacts cache is unavailable: ${contactsLoadError}`, { code: 'contacts_unavailable' });
  }

  throw createServiceError('No contacts are available in Contacts.app.', { code: 'contacts_empty' });
}

function findEntriesByHandle(handle) {
  if (isEmailHandle(handle)) {
    return uniqueEntries(contactsByEmail.get(normalizeEmail(handle)) || []);
  }

  const matches = [];
  for (const key of getPhoneLookupKeys(handle)) {
    matches.push(...(contactsByPhone.get(key) || []));
  }
  return uniqueEntries(matches);
}

function findEntriesByName(name) {
  const query = collapseWhitespace(name).toLowerCase();
  if (!query) return [];

  const exactMatches = uniqueEntries(contactsByName.get(query) || []);
  if (exactMatches.length > 0) {
    return sortContactEntries(exactMatches);
  }

  const partialMatches = contactEntries.filter((entry) => entry.name.toLowerCase().includes(query));
  return sortContactEntries(uniqueEntries(partialMatches));
}

function resolveContact(contact) {
  const rawContact = collapseWhitespace(contact);
  if (!rawContact) {
    throw createServiceError('contact is required', { code: 'contact_required' });
  }

  let matches = [];
  if (isEmailHandle(rawContact) || normalizePhoneDigits(rawContact).length >= 7) {
    matches = findEntriesByHandle(rawContact);
  } else {
    matches = findEntriesByName(rawContact);
    if (matches.length === 0) {
      matches = findEntriesByHandle(rawContact);
    }
  }

  if (matches.length === 0) {
    throw createServiceError('Recipient not found in your Contacts. Add them to the Contacts app first.', {
      code: 'contact_not_found'
    });
  }

  if (matches.length > 1) {
    throw createServiceError('Multiple contacts matched. Clarify with a last name or number.', {
      code: 'contact_ambiguous',
      matches: matches.map(formatContactEntry)
    });
  }

  return matches[0];
}

function buildHandleMatchClause(handle) {
  if (isEmailHandle(handle)) {
    return `lower(h.id) = '${sqlString(normalizeEmail(handle))}'`;
  }

  const keys = getPhoneLookupKeys(handle);
  if (keys.length === 0) {
    throw new Error('Unable to normalize contact handle');
  }

  return '(' + keys.map((key) => `${PHONE_SQL_NORMALIZER} = '${sqlString(key)}'`).join(' OR ') + ')';
}

function formatMessageRow(row, contactEntry) {
  const text = row.text || extractTextFromBody(row.body_hex) || '';
  return {
    contact_name: contactEntry.name,
    text: String(text),
    date: cocoaToDate(row.date).toISOString(),
    isFromMe: Number(row.is_from_me || 0) === 1
  };
}

function filterKnownMessages(rows) {
  const messages = [];

  for (const row of rows) {
    const matches = findEntriesByHandle(row.handle);
    if (matches.length === 0) continue;
    const formatted = formatMessageRow(row, matches[0]);
    if (!formatted.text) continue;
    messages.push(formatted);
  }

  return messages;
}

async function handleRecent(request) {
  await ensureContactsLoaded();
  ensureContactsReady();

  const limit = clampLimit(request.limit, 20, 100);
  const rows = await queryChatDb([
    'SELECT m.text, hex(m.attributedBody) as body_hex, m.date, m.is_from_me, h.id as handle, m.ROWID',
    'FROM message m',
    'JOIN handle h ON m.handle_id = h.ROWID',
    "WHERE h.service = 'iMessage'",
    'AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)',
    'ORDER BY m.date DESC',
    'LIMIT 500'
  ].join(' '));

  return filterKnownMessages(rows).slice(0, limit);
}

async function handleConversation(request) {
  await ensureContactsLoaded();
  ensureContactsReady();

  const contact = resolveContact(request.contact);
  const limit = clampLimit(request.limit, 50, 200);
  const rows = await queryChatDb([
    'SELECT m.text, hex(m.attributedBody) as body_hex, m.date, m.is_from_me, h.id as handle',
    'FROM message m',
    'JOIN handle h ON m.handle_id = h.ROWID',
    "WHERE h.service = 'iMessage'",
    `AND ${buildHandleMatchClause(contact.phone)}`,
    'AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)',
    'ORDER BY m.date DESC',
    `LIMIT ${limit}`
  ].join(' '));

  const messages = rows.map((row) => formatMessageRow(row, contact)).reverse();
  return {
    contact_name: contact.name,
    handle: contact.phone,
    messages
  };
}

async function handleSearch(request) {
  await ensureContactsLoaded();
  ensureContactsReady();

  const query = collapseWhitespace(request.query);
  if (!query) {
    throw createServiceError('query is required', { code: 'query_required' });
  }

  const limit = clampLimit(request.limit, 20, 100);
  const whereClauses = [
    `(m.text LIKE '%${escapeSqlLike(query)}%' ESCAPE '\\' OR CAST(m.attributedBody AS TEXT) LIKE '%${escapeSqlLike(query)}%' ESCAPE '\\')`,
    '(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)'
  ];
  let resolvedContact = null;

  if (request.contact) {
    resolvedContact = resolveContact(request.contact);
    whereClauses.push(buildHandleMatchClause(resolvedContact.phone));
  }

  const rows = await queryChatDb([
    'SELECT m.text, hex(m.attributedBody) as body_hex, m.date, m.is_from_me, h.id as handle',
    'FROM message m',
    'JOIN handle h ON m.handle_id = h.ROWID',
    `WHERE h.service = 'iMessage' AND ${whereClauses.join(' AND ')}`,
    'ORDER BY m.date DESC',
    'LIMIT 500'
  ].join(' '));

  const messages = rows
    .map((row) => {
      const matches = resolvedContact ? [resolvedContact] : findEntriesByHandle(row.handle);
      if (matches.length === 0) return null;
      return formatMessageRow(row, matches[0]);
    })
    .filter(Boolean)
    .slice(0, limit);

  return resolvedContact
    ? {
        query,
        contact_name: resolvedContact.name,
        handle: resolvedContact.phone,
        messages
      }
    : {
        query,
        messages
      };
}

async function sendMessage(handle, text) {
  await runAppleScript(sendMessageScript(), [handle, text]);
}

async function handleSend(request) {
  await ensureContactsLoaded();
  ensureContactsReady();

  const contact = resolveContact(request.contact);
  const text = String(request.text || '');

  if (!text.trim()) {
    throw createServiceError('text is required', { code: 'text_required' });
  }

  await sendMessage(contact.phone, text);
  return {
    sent: true,
    to: contact.name,
    handle: contact.phone,
    text: previewText(text)
  };
}

async function handleListContacts() {
  await ensureContactsLoaded();
  ensureContactsReady();
  return contactEntries.map(formatContactEntry);
}

async function dispatchRequest(request) {
  const action = request?.action;

  switch (action) {
    case 'recent':
      return handleRecent(request);
    case 'conversation':
      return handleConversation(request);
    case 'search':
      return handleSearch(request);
    case 'send':
      return handleSend(request);
    case 'list_contacts':
      return handleListContacts(request);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function processRequestFile() {
  if (isProcessing) {
    hasPendingRun = true;
    return;
  }

  isProcessing = true;

  try {
    if (!fs.existsSync(REQUEST_FILE)) {
      return;
    }

    const stats = fs.statSync(REQUEST_FILE);
    if (stats.mtimeMs <= lastProcessedMtimeMs) {
      return;
    }

    lastProcessedMtimeMs = stats.mtimeMs;

    const raw = fs.readFileSync(REQUEST_FILE, 'utf8');
    const request = JSON.parse(raw);
    const action = request?.action || null;

    log(`processing ${action || 'unknown'} request`);

    try {
      const data = await dispatchRequest(request);
      writeResponse(successResponse(action, data));
      log(`completed ${action}`);
    } catch (error) {
      writeResponse(errorResponse(action, error));
      logError(`action ${action || 'unknown'} failed: ${error.message}`);
    }
  } catch (error) {
    writeResponse(errorResponse(null, error));
    logError(`watcher error: ${error.message}`);
  } finally {
    isProcessing = false;
    if (hasPendingRun) {
      hasPendingRun = false;
      setImmediate(() => {
        processRequestFile().catch((error) => logError(`deferred processing failed: ${error.message}`));
      });
    }
  }
}

fs.watchFile(REQUEST_FILE, { interval: POLL_INTERVAL_MS }, (current, previous) => {
  if (current.mtimeMs === 0 || current.mtimeMs === previous.mtimeMs) {
    return;
  }

  processRequestFile().catch((error) => logError(`processing failed: ${error.message}`));
});

processRequestFile().catch((error) => logError(`startup processing failed: ${error.message}`));

loadContacts().catch((error) => {
  contactsLoadError = error.message;
  logError(`failed to load contacts on startup: ${error.message}`);
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'imessage' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/reload-contacts') {
    loadContacts()
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'imessage',
          contacts: result
        }));
      })
      .catch((error) => {
        contactsLoadError = error.message;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          service: 'imessage',
          error: error.message
        }));
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  log(`imessage service running on port ${PORT}`);
  log(`watching ${REQUEST_FILE}`);
  log(`health: http://localhost:${PORT}/health`);
});
