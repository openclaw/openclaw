import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_BIN, CLAUDE_RUNTIME_ROOT, DEFAULT_CLAUDE_CWD } from '../config.mjs';
import { safeProjectPath } from './filesystem.mjs';

export const CLAUDE_SESSION_ID = 'claude-default';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DATA_DIR = CLAUDE_RUNTIME_ROOT;
const REGISTRY_PATH = path.join(CLAUDE_DATA_DIR, 'claude-session.json');
const PTY_BRIDGE_PATH = path.join(__dirname, 'claude_pty_bridge.py');
const LOG_TAIL_BYTES = 50_000;

const claudeSessions = new Map();

function ensureClaudeDataDir() {
  fs.mkdirSync(CLAUDE_DATA_DIR, { recursive: true });
}

function normalizeClaudeCwd(cwdRel) {
  return typeof cwdRel === 'string' && cwdRel.trim() ? cwdRel.trim() : DEFAULT_CLAUDE_CWD;
}

function resolveClaudeCommand() {
  const candidates = [
    CLAUDE_BIN,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'claude') {return candidate;}
    try {
      if (fs.existsSync(candidate)) {return candidate;}
    } catch {}
  }
  return 'claude';
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureClaudeDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readLogTail(logPath, maxBytes = LOG_TAIL_BYTES) {
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size || 0;
    const start = Math.max(0, size - maxBytes);
    const truncated = start > 0;
    const fd = fs.openSync(logPath, 'r');
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return { text: buffer.toString('utf8'), truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', truncated: false };
  }
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {return false;}
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function getSessionPaths(sessionId = CLAUDE_SESSION_ID) {
  ensureClaudeDataDir();
  return {
    logPath: path.join(CLAUDE_DATA_DIR, `${sessionId}.log`),
    stdinPath: path.join(CLAUDE_DATA_DIR, `${sessionId}.stdin`),
    statusPath: path.join(CLAUDE_DATA_DIR, `${sessionId}.status.json`),
    resizePath: path.join(CLAUDE_DATA_DIR, `${sessionId}.resize.json`),
  };
}

function buildRegistryPayload(session) {
  return {
    sessionId: session.id,
    cwd: session.cwdRel,
    cwdAbs: session.cwdAbs,
    bridgePid: session.bridgePid ?? null,
    claudeCommand: session.claudeCommand,
    startedAt: session.createdAt || new Date().toISOString(),
    status: session.status || 'idle',
    logPath: session.logPath,
    stdinPath: session.stdinPath,
    statusPath: session.statusPath,
    resizePath: session.resizePath ?? null,
    exitCode: session.exitCode ?? null,
    terminationRequestedAt: session.terminationRequestedAt || null,
    terminatedAt: session.terminatedAt || null,
    terminationError: session.terminationError || null,
    recoveredAt: session.recoveredAt || null,
    updatedAt: new Date().toISOString(),
  };
}

function saveRegistry(session) {
  writeJsonFile(REGISTRY_PATH, buildRegistryPayload(session));
}

function loadRegistry() {
  return readJsonFile(REGISTRY_PATH);
}

function createSessionBase(normalized, cwdAbs, paths, overrides = {}) {
  return {
    id: CLAUDE_SESSION_ID,
    cwdRel: normalized,
    cwdAbs,
    claudeCommand: resolveClaudeCommand(),
    logPath: paths.logPath,
    stdinPath: paths.stdinPath,
    statusPath: paths.statusPath,
    resizePath: paths.resizePath,
    output: '',
    exited: false,
    exitCode: null,
    status: 'running',
    bridgePid: null,
    childPid: null,
    terminationRequestedAt: null,
    terminatedAt: null,
    terminationError: null,
    claudeStarted: false,
    claudeStartedAt: null,
    createdAt: new Date().toISOString(),
    recoveredAt: null,
    ...overrides,
  };
}

function appendSyntheticOutput(logPath, text) {
  ensureClaudeDataDir();
  fs.appendFileSync(logPath, String(text || ''), 'utf8');
}

function cleanupSessionFiles(session) {
  for (const key of ['stdinPath', 'resizePath']) {
    const p = session[key];
    if (p) {try {fs.rmSync(p, { force: true });} catch {}}
  }
}

function enrichSessionFromStatus(session) {
  const status = readJsonFile(session.statusPath);
  if (!status || typeof status !== 'object') {return session;}
  const bridgeAlive = isPidAlive(status.bridgePid ?? session.bridgePid);
  const wasExited = session.exited;
  session.bridgePid = status.bridgePid ?? session.bridgePid;
  session.childPid = status.childPid ?? session.childPid;
  session.exitCode = status.exitCode ?? session.exitCode ?? null;
  session.terminationError = status.error ?? session.terminationError ?? null;
  session.status = bridgeAlive ? (status.status || 'running') : (status.status || session.status || 'exited');
  session.exited = !bridgeAlive && ['terminated', 'exited', 'failed'].includes(session.status);
  if (session.exited && !session.terminatedAt) {session.terminatedAt = status.updatedAt || new Date().toISOString();}
  // Clean up leftover FIFO/resize files the first time we detect exit.
  if (session.exited && !wasExited) {cleanupSessionFiles(session);}
  return session;
}

function materializeSessionFromRegistry(registry, cwdRel) {
  if (!registry || registry.sessionId !== CLAUDE_SESSION_ID) {return null;}
  const paths = getSessionPaths(registry.sessionId);
  const session = {
    id: CLAUDE_SESSION_ID,
    cwdRel: normalizeClaudeCwd(registry.cwd || cwdRel),
    cwdAbs: safeProjectPath(normalizeClaudeCwd(registry.cwd || cwdRel)),
    claudeCommand: registry.claudeCommand || resolveClaudeCommand(),
    bridgePid: registry.bridgePid ?? null,
    childPid: registry.childPid ?? null,
    logPath: registry.logPath || paths.logPath,
    stdinPath: registry.stdinPath || paths.stdinPath,
    statusPath: registry.statusPath || paths.statusPath,
    resizePath: registry.resizePath || paths.resizePath,
    createdAt: registry.startedAt || registry.createdAt || null,
    recoveredAt: new Date().toISOString(),
    claudeStarted: true,
    claudeStartedAt: registry.startedAt || registry.createdAt || null,
    terminationRequestedAt: registry.terminationRequestedAt || null,
    terminatedAt: registry.terminatedAt || null,
    terminationError: registry.terminationError || null,
    exitCode: registry.exitCode ?? null,
    output: '',
    exited: false,
    status: registry.status || 'running',
  };
  enrichSessionFromStatus(session);
  session.output = readLogTail(session.logPath).text;
  return session;
}

function persistAndCacheSession(session) {
  claudeSessions.set(session.id, session);
  saveRegistry(session);
  return session;
}

function buildIdleState(cwdRel = DEFAULT_CLAUDE_CWD) {
  return {
    ok: true,
    sessionId: CLAUDE_SESSION_ID,
    cwd: normalizeClaudeCwd(cwdRel),
    running: false,
    status: 'idle',
    output: '',
    exited: false,
    exitCode: null,
    started: false,
    transport: 'python-pty-bridge-detached',
    shell: 'python3',
    command: resolveClaudeCommand(),
    terminationRequestedAt: null,
    terminatedAt: null,
    terminationError: null,
    bridgePid: null,
    recovered: false,
  };
}

function buildClaudeState(session, cwdRel = DEFAULT_CLAUDE_CWD) {
  if (!session) {return buildIdleState(cwdRel);}
  const { text: outputText, truncated: outputTruncated } = readLogTail(session.logPath);
  session.output = outputText;
  const bridgeAlive = isPidAlive(session.bridgePid);
  if (!bridgeAlive && !session.exited) {
    enrichSessionFromStatus(session);
    if (!session.exited) {
      session.exited = true;
      session.status = session.status === 'terminating' ? 'terminated' : 'exited';
      session.terminatedAt = session.terminatedAt || new Date().toISOString();
    }
    saveRegistry(session);
  }
  return {
    ok: true,
    sessionId: session.id,
    cwd: session.cwdRel,
    running: bridgeAlive && !session.exited,
    status: session.status || (session.exited ? 'exited' : 'running'),
    output: session.output || '',
    outputTruncated,
    exited: !!session.exited,
    exitCode: session.exitCode ?? null,
    started: !!session.claudeStarted,
    transport: 'python-pty-bridge-detached',
    shell: 'python3',
    command: session.claudeCommand,
    terminationRequestedAt: session.terminationRequestedAt || null,
    terminatedAt: session.terminatedAt || null,
    terminationError: session.terminationError || null,
    bridgePid: session.bridgePid ?? null,
    recovered: !!session.recoveredAt,
  };
}

function createFailedSession(cwdRel, errorText) {
  const normalized = normalizeClaudeCwd(cwdRel);
  const cwdAbs = safeProjectPath(normalized);
  const paths = getSessionPaths();
  const session = createSessionBase(normalized, cwdAbs, paths, {
    exited: true,
    status: 'failed',
    terminatedAt: new Date().toISOString(),
    terminationError: errorText,
  });
  appendSyntheticOutput(session.logPath, `[dashboard] starting claude\n${errorText}\n`);
  return persistAndCacheSession(session);
}

function startDetachedClaudeSession(cwdRel) {
  const normalized = normalizeClaudeCwd(cwdRel);
  const cwdAbs = safeProjectPath(normalized);
  const claudeCommand = resolveClaudeCommand();
  if (claudeCommand === 'claude') {return createFailedSession(normalized, 'claude: command not found');}

  const paths = getSessionPaths();
  for (const p of [paths.logPath, paths.statusPath, paths.stdinPath]) {
    try {fs.rmSync(p, { force: true });} catch {}
  }

  const child = spawn('python3', [
    PTY_BRIDGE_PATH,
    '--cwd', cwdAbs,
    '--log', paths.logPath,
    '--stdin', paths.stdinPath,
    '--status', paths.statusPath,
    '--resize', paths.resizePath,
    '--',
    claudeCommand,
  ], {
    cwd: cwdAbs,
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor',
      CLAUDE_CODE_ENTRYPOINT: 'viodashboard',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const session = createSessionBase(normalized, cwdAbs, paths, {
    claudeCommand,
    claudeStarted: true,
    claudeStartedAt: new Date().toISOString(),
    bridgePid: child.pid,
  });
  appendSyntheticOutput(session.logPath, `[dashboard] starting claude\n[cwd] ${cwdAbs}\n`);
  return persistAndCacheSession(session);
}

function rehydrateClaudeSession(cwdRel) {
  const existing = claudeSessions.get(CLAUDE_SESSION_ID);
  if (existing) {return existing;}
  const registry = loadRegistry();
  const session = materializeSessionFromRegistry(registry, cwdRel);
  if (!session) {return null;}
  claudeSessions.set(session.id, session);
  return session;
}

function killBridgePid(pid, signal = 'SIGTERM') {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {return false;}
  try {
    process.kill(numericPid, signal);
    return true;
  } catch {
    return false;
  }
}

export function getClaudeState({ cwdRel } = {}) {
  const session = rehydrateClaudeSession(cwdRel);
  return buildClaudeState(session, cwdRel);
}

export function startClaudeSession({ cwdRel } = {}) {
  const normalized = normalizeClaudeCwd(cwdRel);
  const existing = rehydrateClaudeSession(normalized);
  if (existing && isPidAlive(existing.bridgePid)) {
    if (existing.cwdRel === normalized) {return buildClaudeState(existing, normalized);}
    stopClaudeSession();
  }
  const session = startDetachedClaudeSession(normalized);
  return buildClaudeState(session, normalized);
}

export function sendClaudeInput({ text, cwdRel, raw = false } = {}) {
  let session = rehydrateClaudeSession(cwdRel);
  if (!session || !isPidAlive(session.bridgePid) || session.exited) {
    session = startDetachedClaudeSession(normalizeClaudeCwd(cwdRel));
  }
  const payload = String(text || '');
  if (!payload.length) {return buildClaudeState(session, session.cwdRel);}
  if (!session.stdinPath || !fs.existsSync(session.stdinPath)) {
    throw new Error('Claude stdin pipe is not ready');
  }
  const writer = fs.createWriteStream(session.stdinPath, { flags: 'w' });
  writer.write(raw ? payload : (payload.endsWith('\n') ? payload : `${payload}\n`));
  writer.end();
  session.lastClaudeInputAt = new Date().toISOString();
  saveRegistry(session);
  return buildClaudeState(session, session.cwdRel);
}

export function stopClaudeSession() {
  const session = rehydrateClaudeSession();
  if (!session) {return buildIdleState();}
  session.status = 'terminating';
  session.terminationRequestedAt = new Date().toISOString();
  saveRegistry(session);
  const stopped = killBridgePid(session.bridgePid, 'SIGTERM');
  if (!stopped) {
    session.exited = true;
    session.status = session.status === 'failed' ? 'failed' : 'terminated';
    session.terminatedAt = new Date().toISOString();
    saveRegistry(session);
  }
  return buildClaudeState(session, session.cwdRel);
}

export async function restartClaudeSession({ cwdRel, waitMs = 300 } = {}) {
  stopClaudeSession();
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return startClaudeSession({ cwdRel });
}

export function resizeClaudeSession({ cols, rows } = {}) {
  const session = rehydrateClaudeSession();
  if (session && isPidAlive(session.bridgePid) && !session.exited) {
    const c = Math.max(1, Math.min(500, Number(cols) || 80));
    const r = Math.max(1, Math.min(200, Number(rows) || 24));
    const resizePath = session.resizePath || getSessionPaths().resizePath;
    try {
      fs.writeFileSync(resizePath, JSON.stringify({ cols: c, rows: r }), 'utf8');
    } catch {}
  }
  return buildClaudeState(session, session?.cwdRel);
}
