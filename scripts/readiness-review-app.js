#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4318;
const EXPORT_DIR = '/Users/chrisreyes/.openclaw/workspace/readiness-email-export';
const THREADS_PATH = path.join(EXPORT_DIR, 'threads.jsonl');
const GOLD_SET_PATH = path.join(EXPORT_DIR, 'gold_set_review.csv');
const RUBRIC_PATH = path.join(EXPORT_DIR, 'gold_set_review.md');
const BACKUP_DIR = path.join(EXPORT_DIR, 'backups');
const STATIC_DIR = path.join(__dirname, 'readiness-review-app-static');

const LABEL_FIELDS = [
  'proposal_yes_no',
  'proposal_type',
  'matched_project',
  'matched_item',
  'suggested_update',
  'safe_to_auto_write_later',
  'notes'
];

const PROPOSAL_TYPES = [
  '',
  'drawing_approval',
  'drawing_revision',
  'client_spec_answer',
  'fabric_problem',
  'fabric_status',
  'frame_status',
  'client_item_status',
  'none'
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let sessionBackupPath = null;

const port = getPort(process.argv.slice(2));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${port}`);

    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      return writeJson(res, 200, buildBootstrapPayload());
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const payload = await readJsonBody(req);
      return handleSave(res, payload);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStaticFile(res, path.join(STATIC_DIR, 'index.html'));
    }

    if (req.method === 'GET') {
      const filePath = path.join(STATIC_DIR, sanitizeStaticPath(url.pathname));
      if (filePath.startsWith(STATIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveStaticFile(res, filePath);
      }
    }

    writeJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    writeJson(res, 500, { error: 'SERVER_ERROR', message: error.message });
  }
});

server.listen(port, HOST, () => {
  console.log(`Readiness review app running at http://${HOST}:${port}`);
});

function getPort(argv) {
  const index = argv.indexOf('--port');
  if (index !== -1) {
    const candidate = Number(argv[index + 1]);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return DEFAULT_PORT;
}

function buildBootstrapPayload() {
  const rows = loadJoinedRows();
  return {
    rows,
    stats: buildStats(rows),
    rubric: fs.readFileSync(RUBRIC_PATH, 'utf8'),
    backupCreated: sessionBackupPath ? path.basename(sessionBackupPath) : null,
    proposalTypes: PROPOSAL_TYPES.filter(Boolean)
  };
}

function loadJoinedRows() {
  const threads = readJsonl(THREADS_PATH);
  const goldRows = parseCsv(fs.readFileSync(GOLD_SET_PATH, 'utf8'));
  return joinGoldRows(goldRows, threads).map(({ gold, thread }) => {
    return {
      ...gold,
      participants: Array.isArray(thread?.participants) ? thread.participants : [],
      clean_latest_text: thread?.clean_latest_text || '',
      clean_thread_excerpt: thread?.clean_thread_excerpt || '',
      thread_subject: thread?.subject || gold.subject || '',
      thread_mailbox: thread?.mailbox || gold.mailbox || '',
      thread_missing: thread == null
    };
  });
}

function handleSave(res, payload) {
  const reviewPriority = String(payload?.review_priority || '').trim();
  if (!reviewPriority) {
    return writeJson(res, 400, { error: 'INVALID_REQUEST', message: 'review_priority is required' });
  }

  const nextLabels = {};
  for (const field of LABEL_FIELDS) {
    nextLabels[field] = sanitizeFieldValue(payload?.labels?.[field]);
  }

  const { header, rows } = parseCsvWithHeader(fs.readFileSync(GOLD_SET_PATH, 'utf8'));
  const row = rows.find((entry) => String(entry.review_priority || '') === reviewPriority);
  if (!row) {
    return writeJson(res, 404, { error: 'ROW_NOT_FOUND' });
  }

  createBackupIfNeeded();

  for (const field of LABEL_FIELDS) {
    row[field] = nextLabels[field];
  }

  writeCsvAtomic(GOLD_SET_PATH, header, rows);

  const joinedRows = loadJoinedRows();
  writeJson(res, 200, {
    ok: true,
    savedAt: new Date().toISOString(),
    backupCreated: sessionBackupPath ? path.basename(sessionBackupPath) : null,
    stats: buildStats(joinedRows)
  });
}

function sanitizeFieldValue(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function createBackupIfNeeded() {
  if (sessionBackupPath) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  sessionBackupPath = path.join(BACKUP_DIR, `gold_set_review.${formatTimestampForFile(new Date())}.csv`);
  fs.copyFileSync(GOLD_SET_PATH, sessionBackupPath);
}

function formatTimestampForFile(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function writeCsvAtomic(filePath, header, rows) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const output = serializeCsv(header, rows);
  fs.writeFileSync(tempPath, output);
  fs.renameSync(tempPath, filePath);
}

function serializeCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    const values = header.map((field) => csvEscape(row[field] ?? ''));
    lines.push(values.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvEscape(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function buildStats(rows) {
  const labeled = rows.filter(isLabeled).length;
  const unlabeled = rows.length - labeled;
  const byType = {};

  for (const row of rows) {
    const guess = String(row.candidate_event_type_guess || 'unknown');
    byType[guess] = (byType[guess] || 0) + 1;
  }

  return {
    total: rows.length,
    labeled,
    unlabeled,
    byType
  };
}

function isLabeled(row) {
  return LABEL_FIELDS.some((field) => String(row[field] || '').trim() !== '');
}

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

function sanitizeStaticPath(pathname) {
  const trimmed = pathname.replace(/^\/+/, '');
  return trimmed || 'index.html';
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseCsv(text) {
  return parseCsvWithHeader(text).rows;
}

function parseCsvWithHeader(text) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      current.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\n') {
      current.push(cell);
      rows.push(current);
      current = [];
      cell = '';
      continue;
    }

    if (ch !== '\r') {
      cell += ch;
    }
  }

  if (cell.length > 0 || current.length > 0) {
    current.push(cell);
    rows.push(current);
  }

  const [header = [], ...dataRows] = rows;
  const mappedRows = dataRows
    .filter((row) => row.some((value) => String(value || '').trim() !== ''))
    .map((row) => {
      const entry = {};
      for (let i = 0; i < header.length; i += 1) {
        entry[header[i]] = row[i] ?? '';
      }
      return entry;
    });

  return { header, rows: mappedRows };
}

function joinGoldRows(goldRows, threads) {
  const byFullKey = new Map();
  const byMailboxSubject = new Map();
  const byMailboxTimestamp = new Map();

  for (const thread of threads) {
    const fullKey = makeJoinKey(thread.mailbox, thread.subject, thread.latest_timestamp);
    byFullKey.set(fullKey, thread);

    const mailboxSubjectKey = `${thread.mailbox}::${thread.subject}`;
    if (!byMailboxSubject.has(mailboxSubjectKey)) byMailboxSubject.set(mailboxSubjectKey, []);
    byMailboxSubject.get(mailboxSubjectKey).push(thread);

    byMailboxTimestamp.set(`${thread.mailbox}::${thread.latest_timestamp}`, thread);
  }

  for (const candidates of byMailboxSubject.values()) {
    candidates.sort((a, b) => {
      return new Date(b.latest_timestamp).getTime() - new Date(a.latest_timestamp).getTime();
    });
  }

  return goldRows.map((gold) => {
    const fullKey = makeJoinKey(gold.mailbox, gold.subject, gold.latest_timestamp);
    let thread = byFullKey.get(fullKey) || null;

    if (!thread) {
      thread = byMailboxTimestamp.get(`${gold.mailbox}::${gold.latest_timestamp}`) || null;
    }

    if (!thread) {
      const candidates = byMailboxSubject.get(`${gold.mailbox}::${gold.subject}`) || [];
      thread = candidates[0] || null;
    }

    return { gold, thread };
  });
}

function makeJoinKey(mailbox, subject, latestTimestamp) {
  return `${mailbox}::${subject}::${latestTimestamp}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
