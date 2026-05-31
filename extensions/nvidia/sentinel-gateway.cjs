"use strict";
/**
 * NVIDIA Sentinel Gateway  –  rebuilt 2026-05-21
 *
 * Proxy on http://127.0.0.1:18888 that:
 *  - Loads NVIDIA API keys from the vault file
 *  - Watches vault for live key updates
 *  - Round-robins keys across requests
 *  - Retries up to 4 keys on 401/429/5xx/timeout
 *  - Passes /v1/* requests through to api.nvidia.com
 *  - Exposes GET /health for watchdog checks
 *  - Streams responses transparently
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveDefaultHomeDir(env = process.env) {
  for (const candidate of [env.HOME, env.USERPROFILE, os.homedir()]) {
    if (
      !candidate ||
      candidate === "~" ||
      candidate.startsWith("~/") ||
      candidate.startsWith("~\\")
    ) {
      continue;
    }
    return path.resolve(candidate);
  }
  return path.resolve(process.cwd());
}

function expandHomePath(input, homeDir) {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDir, input.slice(2));
  }
  return path.resolve(input);
}

function resolveHomeDir(env = process.env) {
  const home = env.OPENCLAW_HOME || env.HOME || env.USERPROFILE;
  const defaultHome = resolveDefaultHomeDir(env);
  return home ? expandHomePath(home, defaultHome) : defaultHome;
}

function resolveStateDir(env = process.env) {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return resolveUserPath(stateDir, env);
  }
  const homeDir = resolveHomeDir(env);
  const openclawStateDir = path.join(homeDir, ".openclaw");
  try {
    if (fs.existsSync(openclawStateDir)) {
      return openclawStateDir;
    }
  } catch {}
  const legacyStateDir = path.join(homeDir, ".clawdbot");
  try {
    if (fs.existsSync(legacyStateDir)) {
      return legacyStateDir;
    }
  } catch {}
  return openclawStateDir;
}

function resolveUserPath(input, env = process.env) {
  return expandHomePath(input, resolveHomeDir(env));
}

const BLOCKED_WORKSPACE_DOTENV_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOCALAPPDATA",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "NPM_CONFIG_CAFILE",
  "OPENCLAW_BROWSER_CONTROL_HOST",
  "OPENCLAW_BROWSER_CONTROL_PORT",
  "OPENCLAW_BROWSER_EXECUTABLE_PATH",
  "OPENCLAW_CLAWHUB_TOKEN",
  "OPENCLAW_CLAWHUB_URL",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_HOME",
  "OPENCLAW_NVIDIA_VAULT_PATH",
  "OPENCLAW_SENTINEL_HOST",
  "OPENCLAW_SENTINEL_LISTEN_PORT",
  "OPENCLAW_SENTINEL_MAX_BODY_BYTES",
  "OPENCLAW_SENTINEL_PORT",
  "OPENCLAW_SENTINEL_REQUIRE_TOKEN",
  "OPENCLAW_SENTINEL_TOKEN",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_UPDATE_CHANNEL",
  "OPENCLAW_UPDATE_SOURCE",
  "OPENCLAW_SKIP_ONBOARD",
  "OPENCLAW_SKIP_UPDATE_CHECK",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "STATE_DIRECTORY",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

const BLOCKED_WORKSPACE_DOTENV_PREFIXES = [
  "BROWSER_CONTROL_",
  "CHROME_",
  "CLAWHUB_",
  "OPENCLAW_",
  "OPENCLAW_BROWSER_",
  "OPENCLAW_CLAWHUB_",
  "OPENCLAW_GATEWAY_",
  "OPENCLAW_SKIP_",
  "OPENCLAW_UPDATE_",
  "PLAYWRIGHT_",
];
const BLOCKED_WORKSPACE_DOTENV_SUFFIXES = ["_API_HOST", "_BASE_URL", "_HOMESERVER"];
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

function shouldBlockWorkspaceDotEnvKey(key) {
  const upper = key.toUpperCase();
  return (
    BLOCKED_WORKSPACE_DOTENV_KEYS.has(upper) ||
    BLOCKED_WORKSPACE_DOTENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    BLOCKED_WORKSPACE_DOTENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

function fallbackParseDotEnv(src) {
  const parsed = {};
  const lines = src.toString().replace(/\r\n?/gm, "\n");
  DOTENV_LINE.lastIndex = 0;
  let match;
  while ((match = DOTENV_LINE.exec(lines)) !== null) {
    const key = match[1];
    let value = (match[2] || "").trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, "\n");
      value = value.replace(/\\r/g, "\r");
    }
    parsed[key] = value;
  }
  return parsed;
}

const parseDotEnv = fallbackParseDotEnv;

function loadDotEnvFile(targetEnv, dotEnvPath, opts = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(dotEnvPath, "utf8");
  } catch {
    return;
  }

  const parsed = parseDotEnv(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    if (opts.workspace && shouldBlockWorkspaceDotEnvKey(key)) {
      continue;
    }
    if (Object.hasOwn(process.env, key) && process.env[key] !== "") {
      continue;
    }
    if (Object.hasOwn(targetEnv, key) && targetEnv[key] !== "") {
      continue;
    }
    targetEnv[key] = value;
  }
}

function loadDotEnv() {
  const loadedEnv = Object.create(null);
  const seen = new Set();

  function mergedEnv() {
    return { ...process.env, ...loadedEnv };
  }

  function resolveDotEnvCandidate(candidate) {
    return candidate ? resolveUserPath(candidate, mergedEnv()) : "";
  }

  function loadCandidate(candidate, opts = {}) {
    if (!candidate) {
      return;
    }
    const dotEnvPath = resolveDotEnvCandidate(candidate);
    if (seen.has(dotEnvPath)) {
      return;
    }
    seen.add(dotEnvPath);
    loadDotEnvFile(loadedEnv, dotEnvPath, opts);
  }

  loadCandidate(process.env.OPENCLAW_ENV_FILE);

  const stateEnvPath = path.join(resolveStateDir(mergedEnv()), ".env");
  const trustedStateEnvPath = path.resolve(stateEnvPath);
  function loadWorkspaceCandidate(candidate) {
    const dotEnvPath = resolveDotEnvCandidate(candidate);
    if (!dotEnvPath || path.resolve(dotEnvPath) === trustedStateEnvPath) {
      return;
    }
    loadCandidate(dotEnvPath, { workspace: true });
  }

  loadWorkspaceCandidate(path.join(process.cwd(), ".env"));
  loadWorkspaceCandidate(path.resolve(__dirname, "..", "..", ".env"));
  loadCandidate(stateEnvPath);

  const homeDir = resolveHomeDir(mergedEnv());
  const currentStateEnvPath = path.join(resolveStateDir(mergedEnv()), ".env");
  const defaultStateEnvPath = path.join(homeDir, ".openclaw", ".env");
  const explicitStateDir = mergedEnv().OPENCLAW_STATE_DIR?.trim();
  const hasExplicitNonDefaultStateDir =
    explicitStateDir && path.resolve(currentStateEnvPath) !== path.resolve(defaultStateEnvPath);
  if (!hasExplicitNonDefaultStateDir) {
    loadCandidate(path.join(homeDir, ".config", "openclaw", "gateway.env"));
  }

  return loadedEnv;
}

const DOTENV_ENV = loadDotEnv();

function mergedRuntimeEnv() {
  return { ...process.env, ...DOTENV_ENV };
}

function runtimeEnvValue(key) {
  const direct = process.env[key];
  return direct === undefined || direct === "" ? DOTENV_ENV[key] : direct;
}

function runtimeEnvTrimmed(key) {
  return runtimeEnvValue(key)?.trim();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function resolvePort(value, label) {
  const raw = String(value || "").trim();
  if (!raw) {
    return 18888;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && /^\d+$/.test(raw) && parsed >= 1 && parsed <= 65_535) {
    return parsed;
  }
  process.stderr.write(`${label} must be a TCP port number from 1 to 65535. Received: ${raw}\n`);
  process.exit(1);
  return 18888;
}

const SENTINEL_LISTEN_PORT_VALUE = runtimeEnvTrimmed("OPENCLAW_SENTINEL_LISTEN_PORT");
const SENTINEL_PORT_VALUE = runtimeEnvTrimmed("OPENCLAW_SENTINEL_PORT");
const PORT = resolvePort(
  SENTINEL_LISTEN_PORT_VALUE || SENTINEL_PORT_VALUE,
  SENTINEL_LISTEN_PORT_VALUE ? "OPENCLAW_SENTINEL_LISTEN_PORT" : "OPENCLAW_SENTINEL_PORT",
);
const NVIDIA_HOST = "integrate.api.nvidia.com";
const NVIDIA_PORT = 443;
const TIMEOUT_MS = 180_000; // 180 s per key attempt
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_ATTEMPTS = resolvePositiveInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_MAX_ATTEMPTS"),
  DEFAULT_MAX_ATTEMPTS,
);
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = resolvePositiveInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_MAX_BODY_BYTES"),
  DEFAULT_MAX_BODY_BYTES,
);
const DEFAULT_KEY_RPM_WINDOW_MS = 60_000;
const KEY_RPM = resolveNonNegativeInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_KEY_RPM") || runtimeEnvValue("OPENCLAW_SENTINEL_RPM_PER_KEY"),
  0,
);
const KEY_RPM_WINDOW_MS = resolvePositiveInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_KEY_RPM_WINDOW_MS"),
  DEFAULT_KEY_RPM_WINDOW_MS,
);
const KEY_RATE_LIMIT_COOLDOWN_MS = resolvePositiveInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_KEY_RATE_LIMIT_COOLDOWN_MS"),
  KEY_RPM_WINDOW_MS,
);
const KEY_AUTH_COOLDOWN_MS = resolvePositiveInt(
  runtimeEnvValue("OPENCLAW_SENTINEL_KEY_AUTH_COOLDOWN_MS"),
  10 * 60_000,
);
const CONFIGURED_VAULT_PATH = runtimeEnvTrimmed("OPENCLAW_NVIDIA_VAULT_PATH");
const VAULT_PATH = CONFIGURED_VAULT_PATH
  ? resolveUserPath(CONFIGURED_VAULT_PATH, mergedRuntimeEnv())
  : path.join(resolveStateDir(mergedRuntimeEnv()), "workspace_nvidia_key_sentinel", "vault.json");
const SENTINEL_TOKEN = runtimeEnvValue("OPENCLAW_SENTINEL_TOKEN") || "";
const SENTINEL_REQUIRE_TOKEN = ["1", "true", "yes", "on"].includes(
  (runtimeEnvValue("OPENCLAW_SENTINEL_REQUIRE_TOKEN") || "").trim().toLowerCase(),
);
const REQUESTED_HOST = runtimeEnvValue("OPENCLAW_SENTINEL_HOST") || "127.0.0.1";
const HOST = SENTINEL_TOKEN || !SENTINEL_REQUIRE_TOKEN ? REQUESTED_HOST : "127.0.0.1";

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
const logFile = path.join(__dirname, "..", "..", "logs", "sentinel-gateway.log");
function log(msg) {
  const line = `${ts()}: [Sentinel Gateway] ${msg}\n`;
  try {
    process.stdout.write(line);
  } catch {}
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}
function err(msg) {
  const line = `${ts()}: [Sentinel Gateway] ${msg}\n`;
  try {
    process.stderr.write(line);
  } catch {}
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}

if (SENTINEL_REQUIRE_TOKEN && !SENTINEL_TOKEN) {
  err("OPENCLAW_SENTINEL_TOKEN is required when OPENCLAW_SENTINEL_REQUIRE_TOKEN is enabled.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Key vault
// ---------------------------------------------------------------------------
let keys = [];
let cursor = 0;
const inFlightKeys = new Set();
const keyCooldownUntil = new Map();
const keyBlockedUntil = new Map();
const keyRequestTimestamps = new Map();
const KEY_REUSE_COOLDOWN_MS = 1_000;

function pruneKeyState() {
  const validKeys = new Set(keys);
  for (const key of inFlightKeys) {
    if (!validKeys.has(key)) {
      inFlightKeys.delete(key);
    }
  }
  for (const key of keyCooldownUntil.keys()) {
    if (!validKeys.has(key)) {
      keyCooldownUntil.delete(key);
    }
  }
  for (const key of keyBlockedUntil.keys()) {
    if (!validKeys.has(key)) {
      keyBlockedUntil.delete(key);
    }
  }
  for (const key of keyRequestTimestamps.keys()) {
    if (!validKeys.has(key)) {
      keyRequestTimestamps.delete(key);
    }
  }
}

function loadVault() {
  try {
    const raw = fs.readFileSync(VAULT_PATH, "utf8");
    const data = JSON.parse(raw);
    const loaded = Array.isArray(data.keys) ? data.keys.filter(Boolean) : [];
    if (loaded.length === 0) {
      keys = [];
      cursor = 0;
      inFlightKeys.clear();
      keyCooldownUntil.clear();
      keyBlockedUntil.clear();
      keyRequestTimestamps.clear();
      startVaultPolling();
      err("Vault loaded but no keys found; cleared cached keys.");
      return;
    }
    keys = loaded;
    cursor = 0;
    pruneKeyState();
    stopVaultPolling();
    log(`🔑 Cached ${keys.length} valid keys.`);
  } catch (e) {
    const cachedState = keys.length > 0 ? "keeping cached keys" : "no cached keys available";
    if (keys.length === 0) {
      startVaultPolling();
    }
    err(`Failed to load vault: ${e.message}; ${cachedState}.`);
  }
}

function takeNextAttemptKey(attemptedKeys) {
  if (keys.length === 0 || attemptedKeys.size >= keys.length) {
    return null;
  }
  const now = Date.now();
  const availableKeys = keys.filter(
    (key) => !attemptedKeys.has(key) && !keyIsBlocked(key, now) && !keyRpmState(key, now).limited,
  );
  if (availableKeys.length === 0) {
    return null;
  }
  const cooledKeys = availableKeys.filter(
    (key) =>
      !attemptedKeys.has(key) && !inFlightKeys.has(key) && (keyCooldownUntil.get(key) || 0) <= now,
  );
  const idleKeys = availableKeys.filter((key) => !attemptedKeys.has(key) && !inFlightKeys.has(key));
  const fallbackKeys = availableKeys.filter((key) => !attemptedKeys.has(key));
  const candidateKeys =
    cooledKeys.length > 0 ? cooledKeys : idleKeys.length > 0 ? idleKeys : fallbackKeys;
  const candidates = new Set(candidateKeys);
  const startIndex = cursor % keys.length;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIndex + i) % keys.length];
    if (!key || !candidates.has(key)) {
      continue;
    }
    cursor = (startIndex + i + 1) % keys.length;
    return key;
  }
  return null;
}

function reserveAttemptKey(key) {
  inFlightKeys.add(key);
}

function recordKeyAttemptStart(key, now = Date.now()) {
  if (KEY_RPM <= 0) {
    return;
  }
  const timestamps = pruneKeyRequestTimestamps(key, now);
  timestamps.push(now);
  keyRequestTimestamps.set(key, timestamps);
}

function releaseAttemptKey(key) {
  inFlightKeys.delete(key);
  keyCooldownUntil.set(key, Date.now() + KEY_REUSE_COOLDOWN_MS);
}

function blockAttemptKey(key, durationMs) {
  const until = Date.now() + Math.max(1, durationMs);
  const currentUntil = keyBlockedUntil.get(key) || 0;
  keyBlockedUntil.set(key, Math.max(currentUntil, until));
  releaseAttemptKey(key);
}

function pruneKeyRequestTimestamps(key, now = Date.now()) {
  const cutoff = now - KEY_RPM_WINDOW_MS;
  const timestamps = (keyRequestTimestamps.get(key) || []).filter(
    (timestamp) => timestamp > cutoff,
  );
  if (timestamps.length > 0) {
    keyRequestTimestamps.set(key, timestamps);
  } else {
    keyRequestTimestamps.delete(key);
  }
  return timestamps;
}

function keyRpmState(key, now = Date.now()) {
  if (KEY_RPM <= 0) {
    return { limited: false, remaining: null, resetMs: 0, used: 0 };
  }
  const timestamps = pruneKeyRequestTimestamps(key, now);
  const used = timestamps.length;
  const limited = used >= KEY_RPM;
  const resetMs = limited ? Math.max(1, timestamps[0] + KEY_RPM_WINDOW_MS - now) : 0;
  return {
    limited,
    remaining: Math.max(0, KEY_RPM - used),
    resetMs,
    used,
  };
}

function keyIsBlocked(key, now = Date.now()) {
  return (keyBlockedUntil.get(key) || 0) > now;
}

function nextKeyReadyDelayMs(attemptedKeys, now = Date.now()) {
  const waits = [];
  for (const key of keys) {
    if (attemptedKeys.has(key)) {
      continue;
    }
    const blockedUntil = keyBlockedUntil.get(key) || 0;
    const rpm = keyRpmState(key, now);
    const waitMs = Math.max(0, blockedUntil - now, rpm.resetMs);
    if (waitMs <= 0) {
      return null;
    }
    waits.push(waitMs);
  }
  return waits.length > 0 ? Math.min(...waits) : null;
}

function keyPoolStatus(now = Date.now()) {
  let readyKeys = 0;
  let blockedKeys = 0;
  let rpmLimitedKeys = 0;
  let coolingKeys = 0;
  for (const key of keys) {
    const rpm = keyRpmState(key, now);
    const blocked = keyIsBlocked(key, now);
    if (blocked) {
      blockedKeys += 1;
    }
    if (rpm.limited) {
      rpmLimitedKeys += 1;
    }
    if ((keyCooldownUntil.get(key) || 0) > now) {
      coolingKeys += 1;
    }
    if (!blocked && !rpm.limited) {
      readyKeys += 1;
    }
  }
  return {
    blockedKeys,
    coolingKeys,
    inFlightKeys: inFlightKeys.size,
    perKeyRpm: KEY_RPM,
    readyKeys,
    rpmLimitedKeys,
    windowMs: KEY_RPM_WINDOW_MS,
  };
}

// Watch vault directory for changes
const vaultDir = path.dirname(VAULT_PATH);
const vaultFileName = path.basename(VAULT_PATH);
let vaultPollTimer = null;
let vaultPollMode = null;
function startVaultPolling(mode = "until-ready") {
  const alreadyDurable = vaultPollMode === "watch-fallback" || vaultPollMode === "watch-backstop";
  if (!alreadyDurable) {
    vaultPollMode = mode;
  }
  if (vaultPollTimer) {
    return;
  }
  vaultPollTimer = setInterval(loadVault, 30_000);
  vaultPollTimer.unref();
  const reason =
    vaultPollMode === "until-ready" ? "until keys are available" : "as a live reload backstop";
  log(`Polling vault file every 30 seconds ${reason}.`);
}

function stopVaultPolling({ force = false } = {}) {
  if (!vaultPollTimer) {
    return;
  }
  if (!force && (vaultPollMode === "watch-fallback" || vaultPollMode === "watch-backstop")) {
    return;
  }
  clearInterval(vaultPollTimer);
  vaultPollTimer = null;
  vaultPollMode = null;
}

function isVaultWatchEvent(filename) {
  return !filename || filename.toString() === vaultFileName;
}

try {
  // Ensure first-run vault creation is observable even before the validator writes vault.json.
  fs.mkdirSync(vaultDir, { recursive: true });
  const watcher = fs.watch(vaultDir, { persistent: false }, (event, filename) => {
    if (isVaultWatchEvent(filename)) {
      log(`🔄 Vault file changed, reloading keys…`);
      loadVault();
    }
  });
  watcher.unref();
  log(`👁️  Non-blocking directory watcher attached to ${vaultDir}`);
  startVaultPolling("watch-backstop");
} catch (e) {
  err(`⚠️  Could not watch vault dir: ${e.message}`);
  startVaultPolling("watch-fallback");
}

loadVault();

// ---------------------------------------------------------------------------
// Proxy a single attempt to NVIDIA
// ---------------------------------------------------------------------------
function proxyAttempt(apiKey, method, urlPath, reqBody, reqHeaders) {
  return new Promise((resolve, reject) => {
    const outHeaders = {
      ...reqHeaders,
      host: NVIDIA_HOST,
      authorization: `Bearer ${apiKey}`,
      "content-length": Buffer.byteLength(reqBody),
    };
    // Strip hop-by-hop headers
    for (const h of ["connection", "keep-alive", "transfer-encoding", "upgrade"]) {
      delete outHeaders[h];
    }

    const opts = {
      hostname: NVIDIA_HOST,
      port: NVIDIA_PORT,
      method,
      path: urlPath,
      headers: outHeaders,
      timeout: TIMEOUT_MS,
    };

    const upstream = https.request(opts, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });

    upstream.on("timeout", () => {
      upstream.destroy();
      reject(new Error(`Gateway Timeout after ${TIMEOUT_MS / 1000}s`));
    });
    upstream.on("error", reject);

    if (reqBody.length) {
      upstream.write(reqBody);
    }
    upstream.end();
  });
}

class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes.`);
    this.name = "RequestBodyTooLargeError";
  }
}

async function readRequestBody(req) {
  const bodyChunks = [];
  let totalBytes = 0;
  const chunks =
    typeof req.iterator === "function" ? req.iterator({ destroyOnReturn: false }) : req;
  for await (const chunk of chunks) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      req.pause();
      throw new RequestBodyTooLargeError(MAX_BODY_BYTES);
    }
    bodyChunks.push(buffer);
  }
  return Buffer.concat(bodyChunks, totalBytes);
}

function sendJson(res, status, body, callback) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body), callback);
}

function parseRetryAfterMs(value) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/u.test(raw)) {
    return Number.parseInt(raw, 10) * 1_000;
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  return Math.max(1, retryAt - Date.now());
}

function retryAfterSeconds(waitMs) {
  return String(Math.max(1, Math.ceil(waitMs / 1_000)));
}

function sendPoolRateLimited(res, waitMs) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": retryAfterSeconds(waitMs),
  });
  res.end(
    JSON.stringify({
      error: "All Sentinel NVIDIA keys are cooling down or at the configured RPM limit.",
      retryAfterMs: waitMs,
    }),
  );
}

function forwardUpstreamResponse(res, status, headers, stream, onDone = () => {}) {
  let closed = false;
  const finish = () => {
    if (closed) {
      return;
    }
    closed = true;
    onDone();
  };
  const fail = (cause) => {
    if (closed) {
      return;
    }
    finish();
    const message = cause instanceof Error ? cause.message : String(cause);
    err(`Upstream response stream failed: ${message}`);
    if (res.headersSent) {
      res.destroy(cause instanceof Error ? cause : undefined);
      return;
    }
    sendJson(res, 502, { error: "Upstream response stream failed." });
  };

  stream.once("error", fail);
  stream.once("aborted", () => fail(new Error("upstream response aborted")));
  stream.once("end", finish);
  res.once("close", () => {
    if (closed) {
      return;
    }
    stream.destroy();
    finish();
  });

  const fwdHeaders = { ...headers };
  for (const h of ["connection", "keep-alive", "transfer-encoding"]) {
    delete fwdHeaders[h];
  }
  res.writeHead(status, fwdHeaders);
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const ready = keys.length > 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, ready, keys: keys.length, port: PORT, pool: keyPoolStatus() }),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    const ready = keys.length > 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, ready, keys: keys.length, port: PORT, pool: keyPoolStatus() }),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/readyz") {
    const ready = keys.length > 0;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: ready, ready, keys: keys.length, port: PORT, pool: keyPoolStatus() }),
    );
    return;
  }

  // Optional token auth
  if (SENTINEL_TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${SENTINEL_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  if (!req.url.startsWith("/v1/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use /v1/chat/completions etc." }));
    return;
  }

  let reqBody;
  try {
    reqBody = await readRequestBody(req);
  } catch (e) {
    if (e instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: e.message }, () => req.destroy());
      return;
    }
    err(`Failed to read request body: ${e.message}`);
    sendJson(res, 400, { error: "Request body could not be read." });
    return;
  }

  if (keys.length === 0) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No NVIDIA API keys available." }));
    return;
  }

  // Detect stream mode from body so we can log it
  try {
    const parsed = JSON.parse(reqBody.toString("utf8"));
    if (parsed.model) {
      log(`Routing ${parsed.model} via cached Sentinel key.`);
    }
  } catch {}

  let lastError = null;
  const attemptedKeys = new Set();
  let retryBudgetAttempts = 0;
  while (attemptedKeys.size < keys.length) {
    const key = takeNextAttemptKey(attemptedKeys);
    if (!key) {
      const waitMs = nextKeyReadyDelayMs(attemptedKeys);
      if (waitMs !== null) {
        sendPoolRateLimited(res, waitMs);
        return;
      }
      break;
    }
    const attemptNumber = attemptedKeys.size + 1;
    const i = attemptNumber - 1;
    attemptedKeys.add(key);
    reserveAttemptKey(key);
    recordKeyAttemptStart(key);
    let releaseKeyAfterAttempt = true;
    try {
      const { status, headers, stream } = await proxyAttempt(
        key,
        req.method,
        req.url,
        reqBody,
        req.headers,
      );

      // Retry key-specific auth/rate-limit failures, but pass through other client errors.
      if (status < 400 || (status >= 400 && ![401, 429].includes(status) && status < 500)) {
        if (status === 404) {
          const model = (() => {
            try {
              return JSON.parse(reqBody.toString()).model;
            } catch {
              return "?";
            }
          })();
          err(`⚠️  Model ${model} returned HTTP 404`);
        }
        releaseKeyAfterAttempt = false;
        forwardUpstreamResponse(res, status, headers, stream, () => releaseAttemptKey(key));
        return;
      }

      // 401/429 or 5xx: try the next cached key.
      stream.resume();
      if (status === 401) {
        blockAttemptKey(key, KEY_AUTH_COOLDOWN_MS);
      } else if (status === 429) {
        blockAttemptKey(
          key,
          parseRetryAfterMs(headers["retry-after"]) ?? KEY_RATE_LIMIT_COOLDOWN_MS,
        );
      } else {
        retryBudgetAttempts += 1;
        releaseAttemptKey(key);
      }
      releaseKeyAfterAttempt = false;
      err(`Attempt ${attemptNumber} returned HTTP ${status}; rotating key.`);
      lastError = new Error(`HTTP ${status}`);
      if (status >= 500 && retryBudgetAttempts >= MAX_ATTEMPTS) {
        break;
      }
    } catch (e) {
      retryBudgetAttempts += 1;
      err(`❌ Attempt ${i + 1} failed: ${e.message}`);
      if (e.stack) {
        err(e.stack.split("\n").slice(0, 4).join("\n"));
      }
      lastError = e;
      if (retryBudgetAttempts >= MAX_ATTEMPTS) {
        break;
      }
    } finally {
      if (releaseKeyAfterAttempt) {
        releaseAttemptKey(key);
      }
    }
  }

  res.writeHead(503, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: `All ${attemptedKeys.size} key attempts failed. Last: ${lastError?.message}`,
    }),
  );
});

server.listen(PORT, HOST, () => {
  log(`🚀 SOTA Sentinel Running on http://${HOST}:${PORT}`);
  if (!SENTINEL_TOKEN) {
    err(
      "⚠️  OPENCLAW_SENTINEL_TOKEN is not set — inbound requests are unauthenticated. Set this env var to a long random secret to restrict access.",
    );
  }
});

server.on("error", (e) => {
  err(`🔥 Server error: ${e.message}`);
  process.exit(1);
});
