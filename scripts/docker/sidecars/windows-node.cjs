#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const JSON5 = require("json5");
const { ensureProofEventsSchema, recordProofEvent } = require("../../lib/proof-events.cjs");

const DEFAULT_NATIVE_AGENT_IDS = ["uba_god_mode", "pipeline_guardian"];
const DEFAULT_BLACKBOARD_JOURNAL_MODE = "WAL";
const DEFAULT_BLACKBOARD_BUSY_TIMEOUT_MS = 10000;
const BLACKBOARD_JOURNAL_MODES = new Set(["DELETE", "TRUNCATE", "PERSIST", "WAL"]);
const POLL_MS = Number(process.env.SWARM_WINDOWS_NODE_POLL_MS || 1000);
const DISPATCH_ACK_RETRY_MS = Number(process.env.SWARM_WINDOWS_NODE_DISPATCH_ACK_RETRY_MS || 60000);
const AGENT_TIMEOUT_SECONDS = String(process.env.SWARM_WINDOWS_NODE_AGENT_TIMEOUT_SECONDS || 900);
const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;

function cleanString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveUserPath(input, cwd = process.cwd(), homeDir = os.homedir()) {
  const value = cleanString(input);
  if (!value) {
    return null;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(cwd, value);
}

function resolveOpenClawHome() {
  return resolveUserPath(process.env.OPENCLAW_HOME) ?? os.homedir();
}

function resolveStateDir() {
  const openclawHome = resolveOpenClawHome();
  return (
    resolveUserPath(process.env.OPENCLAW_STATE_DIR) ??
    resolveUserPath(process.env.OPENCLAW_CONFIG_DIR) ??
    path.join(openclawHome, ".openclaw")
  );
}

function resolveConfigPath(stateDir = resolveStateDir()) {
  return (
    resolveUserPath(process.env.OPENCLAW_CONFIG_PATH) ??
    path.join(resolveUserPath(process.env.OPENCLAW_CONFIG_DIR) ?? stateDir, "openclaw.json")
  );
}

function resolveRepoRoot() {
  return (
    resolveUserPath(process.env.OPENCLAW_REPO_ROOT) ?? path.resolve(__dirname, "..", "..", "..")
  );
}

function parseAgentIdSet(value, fallback = []) {
  const ids = new Set(fallback);
  if (typeof value !== "string") {
    return ids;
  }
  for (const entry of value.split(/[,\r\n;]+/u)) {
    const id = entry.trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function normalizeRuntimeMarker(value) {
  return cleanString(value)?.toLowerCase().replace(/_/g, "-") ?? null;
}

function agentRequestsHostNativeRuntime(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const params = entry.params && typeof entry.params === "object" ? entry.params : {};
  const markers = new Set([
    "desktop",
    "desktop-native",
    "host",
    "host-native",
    "native",
    "windows",
    "windows-native",
  ]);
  for (const key of ["runtime", "execution", "placement", "node", "runOn", "hostRuntime"]) {
    const marker = normalizeRuntimeMarker(entry[key]);
    if (marker && markers.has(marker)) {
      return true;
    }
  }
  for (const key of ["fullLocalRuntime", "runtime", "placement", "hostRuntime"]) {
    const marker = normalizeRuntimeMarker(params[key]);
    if (marker && markers.has(marker)) {
      return true;
    }
  }
  return entry.native === true || entry.hostNative === true || entry.desktopNative === true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBlockedConfigKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function safeRealpath(filePath) {
  try {
    const nativeRealpath = fs.realpathSync.native;
    return nativeRealpath ? nativeRealpath(filePath) : fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveIncludeRoots() {
  const raw = cleanString(process.env.OPENCLAW_INCLUDE_ROOTS);
  if (!raw) {
    return [];
  }
  const roots = [];
  const seen = new Set();
  for (const entry of raw.split(path.delimiter)) {
    const resolved = resolveUserPath(entry);
    if (!resolved || !path.isAbsolute(resolved) || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

function buildIncludeRoots(configPath) {
  const roots = [path.dirname(configPath), ...resolveIncludeRoots()];
  const seen = new Set();
  return roots
    .map((rootDir) => path.resolve(rootDir))
    .filter((rootDir) => {
      if (seen.has(rootDir)) {
        return false;
      }
      seen.add(rootDir);
      return true;
    })
    .map((rootDir) => ({
      rootDir,
      rootRealDir: safeRealpath(rootDir),
    }));
}

function findContainingRoot(roots, candidatePath, field) {
  for (const root of roots) {
    if (isPathInside(root[field], candidatePath)) {
      return root;
    }
  }
  return null;
}

function resolveConfigIncludePath(includePath, basePath, roots) {
  const resolved = path.normalize(
    path.isAbsolute(includePath) ? includePath : path.resolve(path.dirname(basePath), includePath),
  );
  const lexicalRoot = findContainingRoot(roots, resolved, "rootDir");
  if (!lexicalRoot) {
    throw new Error(`Include path escapes config directory: ${includePath}`);
  }
  const realIncludePath = safeRealpath(resolved);
  const realRoot = findContainingRoot(roots, realIncludePath, "rootRealDir");
  if (!realRoot) {
    throw new Error(`Include path resolves outside config directory: ${includePath}`);
  }
  return realIncludePath;
}

function deepMergeConfig(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (isBlockedConfigKey(key)) {
        continue;
      }
      result[key] = key in result ? deepMergeConfig(result[key], value) : value;
    }
    return result;
  }
  return source;
}

function resolveConfigIncludes(value, params) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigIncludes(item, params));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (!(INCLUDE_KEY in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveConfigIncludes(item, params)]),
    );
  }

  const includeValue = value[INCLUDE_KEY];
  const includeItems = Array.isArray(includeValue) ? includeValue : [includeValue];
  let included = {};
  for (const includeItem of includeItems) {
    if (typeof includeItem !== "string" || includeItem.trim().length === 0) {
      throw new Error(`Invalid ${INCLUDE_KEY} value: expected string or array of strings`);
    }
    if (params.depth >= MAX_INCLUDE_DEPTH) {
      throw new Error(`Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includeItem}`);
    }
    const includePath = resolveConfigIncludePath(includeItem, params.basePath, params.roots);
    if (params.seen.has(includePath)) {
      throw new Error(`Circular include detected: ${[...params.seen, includePath].join(" -> ")}`);
    }
    const parsed = JSON5.parse(fs.readFileSync(includePath, "utf8"));
    const resolved = resolveConfigIncludes(parsed, {
      ...params,
      basePath: includePath,
      depth: params.depth + 1,
      seen: new Set([...params.seen, includePath]),
    });
    included = deepMergeConfig(included, resolved);
  }

  const rest = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== INCLUDE_KEY)
      .map(([key, item]) => [key, resolveConfigIncludes(item, params)]),
  );
  if (Object.keys(rest).length === 0) {
    return included;
  }
  if (!isPlainObject(included)) {
    throw new Error("Sibling keys require included content to be an object");
  }
  return deepMergeConfig(included, rest);
}

const STATE_DIR = resolveStateDir();
const DB_PATH =
  resolveUserPath(process.env.SWARM_BLACKBOARD_DB_PATH) ??
  path.join(STATE_DIR, "swarm_blackboard.db");
const CONFIG_PATH = resolveConfigPath(STATE_DIR);
const REPO_ROOT = resolveRepoRoot();
const OPENCLAW_CLI_BIN =
  resolveUserPath(process.env.OPENCLAW_CLI_PATH, REPO_ROOT) ?? path.join(REPO_ROOT, "openclaw.mjs");
const BLACKBOARD_CLI_PATH =
  resolveUserPath(process.env.OPENCLAW_BLACKBOARD_CLI_PATH, REPO_ROOT) ??
  path.join(REPO_ROOT, "scripts", "docker", "sidecars", "blackboard-cli.cjs");
const PID_PATH =
  resolveUserPath(process.env.SWARM_WINDOWS_NODE_PID_PATH) ??
  path.join(STATE_DIR, "full-local", "windows-node.pid");

let db = null;
let isProcessing = false;

function resolveBlackboardJournalMode() {
  const mode = (process.env.SWARM_BLACKBOARD_JOURNAL_MODE || DEFAULT_BLACKBOARD_JOURNAL_MODE)
    .trim()
    .toUpperCase();
  return BLACKBOARD_JOURNAL_MODES.has(mode) ? mode : DEFAULT_BLACKBOARD_JOURNAL_MODE;
}

function resolveBlackboardBusyTimeoutMs() {
  const timeoutMs = Number(process.env.SWARM_BLACKBOARD_BUSY_TIMEOUT_MS);
  return Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_BLACKBOARD_BUSY_TIMEOUT_MS;
}

function configureBlackboardConnection(conn) {
  conn.exec(`PRAGMA busy_timeout = ${resolveBlackboardBusyTimeoutMs()};`);
  const journalMode = resolveBlackboardJournalMode();
  const current = conn.prepare("PRAGMA journal_mode;").get()?.journal_mode;
  if (String(current || "").toUpperCase() !== journalMode) {
    conn.prepare(`PRAGMA journal_mode = ${journalMode};`).get();
  }
}

function readConfig() {
  try {
    const configPath = path.resolve(CONFIG_PATH);
    return resolveConfigIncludes(JSON5.parse(fs.readFileSync(configPath, "utf8")), {
      basePath: configPath,
      depth: 0,
      roots: buildIncludeRoots(configPath),
      seen: new Set([path.normalize(configPath)]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Windows Node] Failed to read OpenClaw config ${CONFIG_PATH}: ${message}`);
    return { agents: {} };
  }
}

function connectDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const conn = new DatabaseSync(DB_PATH);
  configureBlackboardConnection(conn);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      priority     INTEGER DEFAULT 0,
      target_agent TEXT,
      status       TEXT DEFAULT 'OPEN'
                   CHECK(status IN ('OPEN','CLAIMED','IN_PROGRESS','DONE','FAILED','ARCHIVED')),
      data         TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      claimed_by   TEXT,
      claimed_at   TEXT,
      ttl_minutes  INTEGER
    );

    CREATE TABLE IF NOT EXISTS ticket_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  TEXT NOT NULL,
      event_type TEXT NOT NULL,
      agent_id   TEXT,
      old_value  TEXT,
      new_value  TEXT,
      timestamp  TEXT NOT NULL
    );
  `);
  ensureProofEventsSchema(conn);
  return conn;
}

function findAgentConfig(agentId) {
  const config = readConfig();
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  return list.find((agent) => agent?.id === agentId) ?? null;
}

function resolveNativeAgentIds() {
  const config = readConfig();
  const configured = parseAgentIdSet(
    process.env.OPENCLAW_NATIVE_AGENT_IDS,
    DEFAULT_NATIVE_AGENT_IDS,
  );
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of list) {
    const id = cleanString(agent?.id);
    if (id && agentRequestsHostNativeRuntime(agent)) {
      configured.add(id);
    }
  }
  return configured;
}

function buildAgentPrompt(agentId, ticket) {
  const quotedBlackboardCli = JSON.stringify(BLACKBOARD_CLI_PATH);
  const workInstruction =
    String(ticket.type) === "autonomy_smoke"
      ? "For autonomy_smoke, the entire task is to acknowledge the ticket and immediately mark it DONE. Do not run unrelated tools."
      : "Then process the ticket using the ticket data and available tools.";
  return [
    `You have a new high-priority Blackboard ticket: ${ticket.id} (type: ${ticket.type}).`,
    "Use the exec tool for the state updates. Do not just describe the commands.",
    `First acknowledge the ticket by running: node ${quotedBlackboardCli} update ${ticket.id} --status IN_PROGRESS --agent ${agentId}`,
    workInstruction,
    `When complete, run: node ${quotedBlackboardCli} update ${ticket.id} --status DONE --agent ${agentId}`,
    "If you cannot complete it, run the same update command with --status FAILED and include a concise reason in the ticket data.",
  ].join("\n");
}

function launchNativeAgent(agentId, ticket) {
  const agent = findAgentConfig(agentId);
  if (!agent) {
    console.error(`[Windows Node] Agent ${agentId} not found in ${CONFIG_PATH}`);
    return false;
  }
  const child = spawn(
    process.execPath,
    [
      OPENCLAW_CLI_BIN,
      "agent",
      "--agent",
      agentId,
      "--session-id",
      `blackboard-${ticket.id}`,
      "--message",
      buildAgentPrompt(agentId, ticket),
      "--timeout",
      AGENT_TIMEOUT_SECONDS,
      "--json",
    ],
    {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        OPENCLAW_STATE_DIR: STATE_DIR,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", (error) => {
    console.error(`[Windows Node] Agent ${agentId} failed to launch: ${error.message}`);
  });
  child.unref();
  return true;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimPidFile() {
  try {
    const existing = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    if (processIsAlive(existing)) {
      console.log(`[Windows Node] Existing bridge already active with pid ${existing}.`);
      return false;
    }
  } catch {}
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  fs.writeFileSync(PID_PATH, `${process.pid}\n`, "utf8");
  const release = () => {
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
    try {
      if (fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
        fs.rmSync(PID_PATH, { force: true });
      }
    } catch {}
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return true;
}

function launchLegacyNativeAgent(agentId, ticket) {
  const agent = findAgentConfig(agentId);
  if (!agent?.command) {
    return false;
  }
  const child = spawn(
    agent.command,
    [...(Array.isArray(agent.args) ? agent.args : []), ticket.id],
    {
      cwd: agent.agentDir || REPO_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", (error) => {
    console.error(`[Windows Node] Legacy agent ${agentId} failed to launch: ${error.message}`);
  });
  child.unref();
  return true;
}

function insertEvent(ticketId, type, agentId) {
  db.prepare(
    "INSERT INTO ticket_events (ticket_id, event_type, agent_id, timestamp) VALUES (?, ?, ?, ?)",
  ).run(ticketId, type, agentId, new Date().toISOString());
}

function recordWindowsProofEvent(ticketId, eventType, status, summary, payload) {
  if (!db) {
    return;
  }
  try {
    recordProofEvent(db, {
      component: "windows-node",
      eventType,
      payload,
      status,
      summary,
      ticketId,
    });
  } catch (error) {
    console.warn(`[Windows Node] Could not record proof event ${eventType}: ${error.message}`);
  }
}

function markDispatched(ticketId, agentId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?").run(
    agentId,
    now,
    now,
    ticketId,
  );
  insertEvent(ticketId, "WINDOWS_DISPATCHED", agentId);
  recordWindowsProofEvent(
    ticketId,
    "WINDOWS_NODE_DISPATCHED",
    "ACTION",
    "Windows native bridge dispatched agent",
    {
      agentId,
      dispatchMode:
        process.env.SWARM_WINDOWS_NODE_DISPATCH_MODE === "direct-command"
          ? "direct-command"
          : "openclaw-agent",
    },
  );
}

function markDispatchFailed(ticketId, agentId) {
  insertEvent(ticketId, "WINDOWS_DISPATCH_FAILED", agentId);
  recordWindowsProofEvent(
    ticketId,
    "WINDOWS_NODE_DISPATCH_FAILED",
    "FAIL",
    "Windows native bridge failed to launch agent",
    {
      agentId,
      dispatchMode:
        process.env.SWARM_WINDOWS_NODE_DISPATCH_MODE === "direct-command"
          ? "direct-command"
          : "openclaw-agent",
    },
  );
}

function processTickets() {
  if (isProcessing) {
    return;
  }
  isProcessing = true;
  try {
    if (!db) {
      db = connectDb();
    }
    const nativeAgents = resolveNativeAgentIds();
    const tickets = db
      .prepare("SELECT * FROM tickets WHERE status = 'OPEN' AND target_agent IS NOT NULL")
      .all();
    for (const ticket of tickets) {
      const targetAgent = String(ticket.target_agent || "");
      if (!nativeAgents.has(targetAgent)) {
        continue;
      }
      if (ticket.claimed_at) {
        const dispatchedAt = Date.parse(ticket.claimed_at);
        const elapsed = Date.now() - dispatchedAt;
        if (Number.isFinite(dispatchedAt) && elapsed < DISPATCH_ACK_RETRY_MS) {
          continue;
        }
      }
      const launched =
        process.env.SWARM_WINDOWS_NODE_DISPATCH_MODE === "direct-command"
          ? launchLegacyNativeAgent(targetAgent, ticket)
          : launchNativeAgent(targetAgent, ticket);
      if (launched) {
        markDispatched(ticket.id, targetAgent);
      } else {
        markDispatchFailed(ticket.id, targetAgent);
      }
    }
  } catch (error) {
    console.error(`[Windows Node] Error: ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

function start() {
  if (!claimPidFile()) {
    return;
  }
  console.log(`[Windows Node] Monitoring native tickets in ${DB_PATH}`);
  console.log(`[Windows Node] Repo root: ${REPO_ROOT}`);
  setInterval(processTickets, POLL_MS);
  processTickets();
}

if (require.main === module) {
  start();
}

module.exports = {
  readConfig,
  resolveConfigIncludes,
  resolveNativeAgentIds,
  start,
};
