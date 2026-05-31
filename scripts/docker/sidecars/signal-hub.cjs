#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ensureProofEventsSchema, recordProofEvent } = require("../../lib/proof-events.cjs");

let sqliteVec = null;
try {
  sqliteVec = require("sqlite-vec");
} catch {}

const DB_PATH = path.join(os.homedir(), ".openclaw", "swarm_blackboard.db");
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
const OPENCLAW_CLI_BIN = process.env.OPENCLAW_CLI_PATH || "/app/openclaw.mjs";
const NODE_TYPE = process.env.SWARM_NODE_TYPE || "linux-container";
const BLACKBOARD_CLI_PATH = "/app/scripts/docker/sidecars/blackboard-cli.cjs";
const DEFAULT_NATIVE_AGENT_IDS = ["uba_god_mode", "pipeline_guardian"];
const DEFAULT_BLACKBOARD_JOURNAL_MODE = "WAL";
const DEFAULT_BLACKBOARD_BUSY_TIMEOUT_MS = 10000;
const BLACKBOARD_JOURNAL_MODES = new Set(["DELETE", "TRUNCATE", "PERSIST", "WAL"]);
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/embeddings";
const EMBEDDING_MODEL = "nvidia/nv-embed-v1";
const EMBEDDING_TIMEOUT_MS = Number(process.env.SWARM_SIGNAL_EMBEDDING_TIMEOUT_MS || 5000);
const LAUNCH_CONFIRM_MS = Number(process.env.SWARM_SIGNAL_LAUNCH_CONFIRM_MS || 2000);
const DISPATCH_ACK_RETRY_MS = Number(process.env.SWARM_SIGNAL_DISPATCH_ACK_RETRY_MS || 180000);
const ACK_ONLY_FINALIZE_GRACE_MS = Number(
  process.env.SWARM_SIGNAL_ACK_ONLY_FINALIZE_GRACE_MS || 15000,
);
const AGENT_TIMEOUT_SECONDS = String(process.env.SWARM_SIGNAL_AGENT_TIMEOUT_SECONDS || 600);
const FULL_LOCAL_SMOKE_CREATED_BY = "scripts/docker/full-local.mjs";
const FULL_LOCAL_SMOKE_NONCE_PREFIX = "full-local-smoke-";
const FULL_LOCAL_SMOKE_STALE_MS = Number(
  process.env.SWARM_SIGNAL_FULL_LOCAL_SMOKE_STALE_MS || 30 * 60 * 1000,
);

const AGENT_CAPABILITIES = [
  { desc: "Code optimization, system auditing, refactoring, code review", id: "senior_auditor" },
  { desc: "Plot generation, story outlines, creative writing", id: "plot_factory" },
  { desc: "Image analysis, visual inspection", id: "image_analyzer" },
  { desc: "Campaign checking, marketing, ad management", id: "campaign_manager" },
  { desc: "YouTube task, video processing, upload", id: "youtube_pipeline" },
  { desc: "Software development, bug fixing, feature building", id: "developer_agency" },
  { desc: "Goal decomposition, task routing, general orchestration", id: "master_orchestrator" },
  {
    desc: "Private research, metasearch, citations, archive search, semantic retrieval",
    id: "research_agent",
  },
  {
    desc: "Browser operations, web automation, visual QA, authenticated session handoff",
    id: "browser_ops_agent",
  },
  {
    desc: "Security events, bouncers, advisory triage, secret scanning, incident response",
    id: "security_bouncer_agent",
  },
];

const TICKET_TYPE_AGENT_MAP = new Map([
  ["autonomy_smoke", "main"],
  ["browser_e2e", "browser_ops_agent"],
  ["browser_ops", "browser_ops_agent"],
  ["browser_task", "browser_ops_agent"],
  ["citation_answer", "research_agent"],
  ["image_analysis", "image_analyzer"],
  ["dependency_advisory", "security_bouncer_agent"],
  ["knowledge_search", "research_agent"],
  ["video_gen", "youtube_pipeline"],
  ["private_search", "research_agent"],
  ["research", "research_agent"],
  ["security", "security_bouncer_agent"],
  ["security_event", "security_bouncer_agent"],
  ["security_incident", "security_bouncer_agent"],
  ["secret_scan", "security_bouncer_agent"],
  ["social_post", "campaign_manager"],
  ["code_review", "senior_auditor"],
  ["perf_optimization", "developer_agency"],
  ["novel_chapter", "plot_factory"],
  ["threat_triage", "security_bouncer_agent"],
  ["ui_qa", "browser_ops_agent"],
  ["upload_short", "youtube_pipeline"],
  ["upload_main_video", "youtube_pipeline"],
  ["web_automation", "browser_ops_agent"],
  ["web_qa", "browser_ops_agent"],
  ["web_research", "research_agent"],
]);

function parseApiKeyPool(...values) {
  const keys = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const entry of String(value).split(/[,\r\n]+/u)) {
      const key = entry.trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

const API_KEYS = parseApiKeyPool(
  process.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS,
  process.env.NVIDIA_API_KEYS,
  process.env.NVIDIA_API_KEY,
);
let embeddingKeyCursor = 0;
let agentEmbeddings = [];
let db = null;
let isProcessing = false;
let sqliteVecUnavailableLogged = false;
let vectorRoutingUnavailableLogged = false;

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

function loadConfiguredAgentIds() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/u, ""));
    const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const ids = new Set();
    for (const agent of agents) {
      if (typeof agent?.id === "string" && agent.id.trim()) {
        ids.add(agent.id.trim());
      }
    }
    return ids;
  } catch (error) {
    console.warn(
      `[Signal Hub] Could not read configured agents from ${CONFIG_PATH}: ${error.message}`,
    );
    return new Set();
  }
}

const NATIVE_AGENTS = parseAgentIdSet(
  process.env.OPENCLAW_NATIVE_AGENT_IDS,
  DEFAULT_NATIVE_AGENT_IDS,
);
const CONFIGURED_AGENT_IDS = loadConfiguredAgentIds();
const ACTIVE_AGENT_CAPABILITIES =
  CONFIGURED_AGENT_IDS.size > 0
    ? AGENT_CAPABILITIES.filter((agent) => CONFIGURED_AGENT_IDS.has(agent.id))
    : AGENT_CAPABILITIES;

console.log(`[Signal Hub] Node Type: ${NODE_TYPE}`);
console.log(`[Signal Hub] Blackboard SQLite: ${DB_PATH}`);
console.log(`[Signal Hub] NVIDIA embedding key pool: ${API_KEYS.length} key(s).`);
console.log(
  `[Signal Hub] Configured agent registry: ${
    CONFIGURED_AGENT_IDS.size > 0 ? `${CONFIGURED_AGENT_IDS.size} agent(s)` : "unavailable"
  }.`,
);

function loadSqliteVec(conn) {
  if (!sqliteVec) {
    if (!sqliteVecUnavailableLogged) {
      console.warn("[Signal Hub] sqlite-vec unavailable; semantic routing will use type fallback.");
      sqliteVecUnavailableLogged = true;
    }
    return false;
  }
  try {
    if (typeof conn.enableLoadExtension === "function") {
      conn.enableLoadExtension(true);
    }
    sqliteVec.load(conn);
    return true;
  } catch (error) {
    if (!sqliteVecUnavailableLogged) {
      console.warn(
        `[Signal Hub] sqlite-vec load failed; semantic routing will use type fallback: ${error.message}`,
      );
      sqliteVecUnavailableLogged = true;
    }
    return false;
  }
}

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

function ensureSchema(conn, vectorEnabled) {
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
  if (vectorEnabled) {
    try {
      conn.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS vec_tickets USING vec0(rowid INTEGER PRIMARY KEY, embedding float[4096]);",
      );
    } catch (error) {
      console.warn(`[Signal Hub] vec_tickets disabled: ${error.message}`);
    }
  }
}

function recordSignalProofEvent(ticketId, eventType, status, summary, payload) {
  if (!db) {
    return;
  }
  try {
    recordProofEvent(db, {
      component: "signal-hub",
      eventType,
      payload,
      status,
      summary,
      ticketId,
    });
  } catch (error) {
    console.warn(`[Signal Hub] Could not record proof event ${eventType}: ${error.message}`);
  }
}

function connectDb() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const conn = new DatabaseSync(DB_PATH, { allowExtension: true });
    const vectorEnabled = loadSqliteVec(conn);
    ensureSchema(conn, vectorEnabled);
    return conn;
  } catch (error) {
    console.error("[Signal Hub] Failed to connect to DB:", error.message);
    return null;
  }
}

async function fetchEmbeddingWithKey(text, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(NVIDIA_ENDPOINT, {
      body: JSON.stringify({
        encoding_format: "float",
        input: [text],
        input_type: "passage",
        model: EMBEDDING_MODEL,
      }),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const result = await response.json();
    return Array.isArray(result?.data?.[0]?.embedding) ? result.data[0].embedding : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getEmbedding(text) {
  if (API_KEYS.length === 0) {
    return null;
  }
  for (let attempt = 0; attempt < API_KEYS.length; attempt += 1) {
    const index = (embeddingKeyCursor + attempt) % API_KEYS.length;
    const embedding = await fetchEmbeddingWithKey(text, API_KEYS[index]);
    if (embedding) {
      embeddingKeyCursor = (index + 1) % API_KEYS.length;
      return embedding;
    }
  }
  return null;
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < vecA.length; index += 1) {
    dotProduct += vecA[index] * vecB[index];
    normA += vecA[index] * vecA[index];
    normB += vecB[index] * vecB[index];
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hasVectorSignal(vector) {
  return Boolean(vector?.some((value) => value !== 0));
}

function decodeFloat32Vector(value) {
  if (value instanceof Float32Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return null;
    }
    return new Float32Array(
      value.buffer,
      value.byteOffset,
      value.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return null;
    }
    return new Float32Array(value);
  }
  return null;
}

function routeByTicketType(ticket) {
  const mapped =
    TICKET_TYPE_AGENT_MAP.get(
      String(ticket.type || "")
        .trim()
        .toLowerCase(),
    ) || "master_orchestrator";
  if (CONFIGURED_AGENT_IDS.size === 0 || CONFIGURED_AGENT_IDS.has(mapped)) {
    return mapped;
  }
  if (CONFIGURED_AGENT_IDS.has("master_orchestrator")) {
    return "master_orchestrator";
  }
  return CONFIGURED_AGENT_IDS.has("main") ? "main" : mapped;
}

function parseTicketData(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return null;
  }
  if (ticket.data && typeof ticket.data === "object") {
    return ticket.data;
  }
  if (typeof ticket.data !== "string" || ticket.data.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(ticket.data);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isStaleFullLocalSmokeTicket(ticket) {
  const data = parseTicketData(ticket);
  if (
    data?.createdBy !== FULL_LOCAL_SMOKE_CREATED_BY ||
    typeof data.nonce !== "string" ||
    !data.nonce.startsWith(FULL_LOCAL_SMOKE_NONCE_PREFIX)
  ) {
    return false;
  }
  const createdAt = Date.parse(ticket.created_at || "");
  return Number.isFinite(createdAt) && Date.now() - createdAt >= FULL_LOCAL_SMOKE_STALE_MS;
}

function isCapabilityRoutingProofTicket(ticket) {
  const data = parseTicketData(ticket);
  return (
    data?.purpose === "capability-agent-routing-proof" ||
    (typeof ticket?.data === "string" && ticket.data.includes("capability-agent-routing-proof"))
  );
}

function isAckOnlyProofTicket(ticket) {
  return String(ticket.type) === "autonomy_smoke" || isCapabilityRoutingProofTicket(ticket);
}

function selectAgentForTicket(ticket) {
  let bestAgent = routeByTicketType(ticket);
  let bestScore = -1;
  if (agentEmbeddings.length === 0) {
    return { agentId: bestAgent, mode: "type-fallback", score: bestScore };
  }
  try {
    const row = db
      .prepare("SELECT embedding FROM vec_tickets WHERE rowid = ?")
      .get(BigInt(ticket.rowid));
    if (!row?.embedding) {
      return { agentId: bestAgent, mode: "type-fallback", score: bestScore };
    }
    const ticketVec = decodeFloat32Vector(row.embedding);
    if (!hasVectorSignal(ticketVec)) {
      return { agentId: bestAgent, mode: "type-fallback", score: bestScore };
    }
    for (const agent of agentEmbeddings) {
      const score = cosineSimilarity(ticketVec, agent.vector);
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent.id;
      }
    }
    return { agentId: bestAgent, mode: "semantic", score: bestScore };
  } catch (error) {
    if (!vectorRoutingUnavailableLogged) {
      console.warn(
        `[Signal Hub] Vector routing unavailable; falling back to type routing: ${error.message}`,
      );
      vectorRoutingUnavailableLogged = true;
    }
    return { agentId: bestAgent, mode: "type-fallback", score: bestScore };
  }
}

async function initEmbeddings() {
  const embeddings = await Promise.all(
    ACTIVE_AGENT_CAPABILITIES.map(async (agent) => {
      const vector = await getEmbedding(agent.desc);
      return hasVectorSignal(vector) ? { id: agent.id, vector } : null;
    }),
  );
  agentEmbeddings = embeddings.filter(Boolean);
  console.log(`[Signal Hub] Cached ${agentEmbeddings.length} agent embeddings.`);
}

async function triggerAgent(agentId, ticket) {
  const displayAgentId = String(agentId);
  const displayTicketId = String(ticket.id ?? "unknown");
  const workInstruction =
    String(ticket.type) === "autonomy_smoke"
      ? "For autonomy_smoke, the entire task is to acknowledge the ticket and immediately mark it DONE. Do not run unrelated tools."
      : isCapabilityRoutingProofTicket(ticket)
        ? "For this capability routing proof, the entire task is to acknowledge the ticket and immediately mark it DONE. Do not bootstrap, browse, or run unrelated tools."
        : "Then process the ticket using the ticket data and available tools.";
  const prompt = [
    `You have a new high-priority Blackboard ticket: ${displayTicketId} (type: ${String(ticket.type)}).`,
    "Use the exec tool for the state updates. Do not just describe the commands.",
    `First acknowledge the ticket by running: node ${BLACKBOARD_CLI_PATH} update ${displayTicketId} --status IN_PROGRESS --agent ${displayAgentId}`,
    workInstruction,
    `When complete, run: node ${BLACKBOARD_CLI_PATH} update ${displayTicketId} --status DONE --agent ${displayAgentId}`,
    "If you cannot complete it, run the same update command with --status FAILED and include a concise reason in the ticket data.",
  ].join("\n");

  return await new Promise((resolve) => {
    const child = spawn(
      "node",
      [
        OPENCLAW_CLI_BIN,
        "agent",
        "--agent",
        displayAgentId,
        "--session-id",
        `blackboard-${displayTicketId}`,
        "--message",
        prompt,
        "--timeout",
        AGENT_TIMEOUT_SECONDS,
        "--json",
      ],
      {
        cwd: "/app",
        detached: true,
        stdio: "ignore",
      },
    );
    let settled = false;
    const finish = (ok, message = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (ok) {
        child.unref();
        console.log(
          `[Signal Hub] Agent ${displayAgentId} dispatched for ticket ${displayTicketId}.`,
        );
      } else {
        const messageSuffix = message ? `: ${String(message)}` : ".";
        console.error(
          `[Signal Hub] Agent ${displayAgentId} failed to launch for ticket ${displayTicketId}${messageSuffix}`,
        );
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(true), Math.max(0, LAUNCH_CONFIRM_MS));
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(false, error.message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish(code === 0 && signal == null, `exit=${code ?? "null"} signal=${signal ?? "null"}`);
    });
  });
}

function markAsDispatched(ticket, agentId) {
  const now = new Date().toISOString();
  const status = isAckOnlyProofTicket(ticket) ? "IN_PROGRESS" : ticket.status;
  db.prepare(
    "UPDATE tickets SET status = ?, claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?",
  ).run(status, agentId, now, now, ticket.id);
  db.prepare(
    "INSERT INTO ticket_events (ticket_id, event_type, agent_id, timestamp) VALUES (?, ?, ?, ?)",
  ).run(ticket.id, "DISPATCHED", agentId, now);
  recordSignalProofEvent(ticket.id, "SIGNAL_DISPATCHED", "ACTION", "Signal hub dispatched agent", {
    ackOnly: isAckOnlyProofTicket(ticket),
    agentId,
  });
}

function markDispatchFailed(ticketId, agentId) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE tickets SET status = 'FAILED', claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?",
  ).run(agentId, now, now, ticketId);
  db.prepare(
    "INSERT INTO ticket_events (ticket_id, event_type, agent_id, timestamp) VALUES (?, ?, ?, ?)",
  ).run(ticketId, "DISPATCH_FAILED", agentId, now);
  recordSignalProofEvent(
    ticketId,
    "SIGNAL_DISPATCH_FAILED",
    "FAIL",
    "Signal hub failed to launch agent",
    { agentId },
  );
}

function archiveStaleFullLocalSmokeTicket(ticketId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET status = 'ARCHIVED', updated_at = ? WHERE id = ?").run(
    now,
    ticketId,
  );
  db.prepare(
    "INSERT INTO ticket_events (ticket_id, event_type, agent_id, timestamp) VALUES (?, ?, ?, ?)",
  ).run(ticketId, "ARCHIVED_STALE_FULL_LOCAL_SMOKE", "signal-hub", now);
  recordSignalProofEvent(
    ticketId,
    "SIGNAL_ARCHIVED_STALE_FULL_LOCAL_SMOKE",
    "WARN",
    "Signal hub archived stale full-local smoke ticket",
    { staleMs: FULL_LOCAL_SMOKE_STALE_MS },
  );
  console.warn(`[Signal Hub] Archived stale full-local smoke ticket ${ticketId}.`);
}

function finalizeAckOnlyProofTickets() {
  const rows = db
    .prepare("SELECT * FROM tickets WHERE status = 'IN_PROGRESS' AND claimed_by IS NOT NULL")
    .all();
  const nowMs = Date.now();
  for (const ticket of rows) {
    if (!isAckOnlyProofTicket(ticket)) {
      continue;
    }
    const claimedAt = Date.parse(ticket.claimed_at || "");
    if (!Number.isFinite(claimedAt) || nowMs - claimedAt < ACK_ONLY_FINALIZE_GRACE_MS) {
      continue;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE tickets SET status = 'DONE', updated_at = ? WHERE id = ?").run(
      now,
      ticket.id,
    );
    db.prepare(
      "INSERT INTO ticket_events (ticket_id, event_type, agent_id, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      ticket.id,
      "ACK_ONLY_AUTO_DONE",
      "signal-hub",
      JSON.stringify(ticket),
      JSON.stringify({
        reason: "agent acknowledged ack-only proof ticket; signal-hub finalized after grace",
        status: "DONE",
      }),
      now,
    );
    recordSignalProofEvent(
      ticket.id,
      "SIGNAL_ACK_ONLY_AUTO_DONE",
      "PASS",
      "Signal hub finalized ack-only proof ticket after acknowledgement",
      {
        agentId: ticket.claimed_by,
        graceMs: ACK_ONLY_FINALIZE_GRACE_MS,
      },
    );
    console.log(`[Signal Hub] Finalized ack-only proof ticket ${ticket.id} after agent ack.`);
  }
}

async function processNewTickets() {
  if (isProcessing) {
    return;
  }
  isProcessing = true;
  try {
    if (!db) {
      db = connectDb();
    }
    if (!db) {
      return;
    }
    finalizeAckOnlyProofTickets();
    const tickets = db
      .prepare("SELECT rowid, * FROM tickets WHERE status IN ('OPEN', 'CLAIMED')")
      .all();
    for (const ticket of tickets) {
      if (isStaleFullLocalSmokeTicket(ticket)) {
        archiveStaleFullLocalSmokeTicket(ticket.id);
        continue;
      }
      if (ticket.status === "OPEN" && ticket.claimed_at) {
        const dispatchedAt = Date.parse(ticket.claimed_at || "");
        const elapsed = Date.now() - dispatchedAt;
        if (Number.isFinite(dispatchedAt) && elapsed < DISPATCH_ACK_RETRY_MS) {
          continue;
        }
        console.warn(`[Signal Hub] Re-dispatching unacknowledged ticket ${ticket.id}.`);
      }
      if (ticket.status === "CLAIMED") {
        const claimedAt = Date.parse(ticket.claimed_at || "");
        const elapsed = Date.now() - claimedAt;
        const ttlMs = (ticket.ttl_minutes || 60) * 60 * 1000;
        if (Number.isFinite(claimedAt) && elapsed < ttlMs) {
          continue;
        }
        console.warn(`[Signal Hub] Re-dispatching expired claimed ticket ${ticket.id}.`);
      }
      let targetAgent = ticket.target_agent;
      if (!targetAgent) {
        const selection = selectAgentForTicket(ticket);
        targetAgent = selection.agentId;
        recordSignalProofEvent(ticket.id, "SIGNAL_ROUTE", "INFO", "Signal hub selected agent", {
          agentId: targetAgent,
          mode: selection.mode,
          score: selection.score,
          ticketType: ticket.type,
        });
        console.log(
          `[Signal Hub] Route: ${ticket.id} (${ticket.type}) -> ${targetAgent} via ${selection.mode} (${selection.score.toFixed(3)})`,
        );
      } else {
        recordSignalProofEvent(ticket.id, "SIGNAL_ROUTE", "INFO", "Ticket used target agent", {
          agentId: targetAgent,
          mode: "target-agent",
          ticketType: ticket.type,
        });
      }
      if (NODE_TYPE === "linux-container" && NATIVE_AGENTS.has(targetAgent)) {
        recordSignalProofEvent(
          ticket.id,
          "SIGNAL_SKIPPED_NATIVE_AGENT",
          "WARN",
          "Linux signal hub skipped host-native agent",
          { agentId: targetAgent, nodeType: NODE_TYPE },
        );
        continue;
      }
      if (NODE_TYPE === "windows-native" && !NATIVE_AGENTS.has(targetAgent)) {
        recordSignalProofEvent(
          ticket.id,
          "SIGNAL_SKIPPED_CONTAINER_AGENT",
          "WARN",
          "Windows native bridge skipped container agent",
          { agentId: targetAgent, nodeType: NODE_TYPE },
        );
        continue;
      }
      if (isAckOnlyProofTicket(ticket)) {
        markAsDispatched(ticket, targetAgent);
        continue;
      }
      if (await triggerAgent(targetAgent, ticket)) {
        markAsDispatched(ticket, targetAgent);
      } else {
        markDispatchFailed(ticket.id, targetAgent);
      }
    }
  } catch (error) {
    console.error("[Signal Hub] Error processing signals:", error.message);
  } finally {
    isProcessing = false;
  }
}

function pollDatabase() {
  if (!db) {
    db = connectDb();
  }
  if (!db) {
    return;
  }
  try {
    void processNewTickets();
  } catch (error) {
    console.error("[Signal Hub] DB polling error:", error.message);
  }
}

console.log("[Signal Hub] Polling active every 1s.");
setInterval(pollDatabase, 1000);
void processNewTickets();

void initEmbeddings().catch((error) => {
  console.warn(`[Signal Hub] Embedding warmup failed; semantic routing disabled: ${error.message}`);
});
