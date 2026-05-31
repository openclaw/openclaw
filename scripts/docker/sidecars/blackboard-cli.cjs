#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  ensureProofEventsSchema,
  listProofEvents,
  recordProofEvent,
  summarizeProofEvents,
} = require("../../lib/proof-events.cjs");
const {
  assertAgentOsTicket,
  normalizeAgentOsTicketStatus,
} = require("../../lib/agent-os-contracts.cjs");

let sqliteVec = null;
try {
  sqliteVec = require("sqlite-vec");
} catch {}

const DB_PATH = path.join(os.homedir(), ".openclaw", "swarm_blackboard.db");
const EMBEDDING_DIM = 4096;
const EMBEDDING_MODEL = "nvidia/nv-embed-v1";
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/embeddings";
const EMBEDDING_TIMEOUT_MS = Number(process.env.SWARM_SIGNAL_EMBEDDING_TIMEOUT_MS || 5000);

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
const DEFAULT_BLACKBOARD_JOURNAL_MODE = "WAL";
const DEFAULT_BLACKBOARD_BUSY_TIMEOUT_MS = 10000;
const BLACKBOARD_JOURNAL_MODES = new Set(["DELETE", "TRUNCATE", "PERSIST", "WAL"]);

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

function configureBlackboardConnection(db) {
  db.exec(`PRAGMA busy_timeout = ${resolveBlackboardBusyTimeoutMs()};`);
  const journalMode = resolveBlackboardJournalMode();
  const current = db.prepare("PRAGMA journal_mode;").get()?.journal_mode;
  if (String(current || "").toUpperCase() !== journalMode) {
    db.prepare(`PRAGMA journal_mode = ${journalMode};`).get();
  }
}

function parseJsonMaybe(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveProofStatusForTicketEvent(eventType, newValue) {
  if (eventType === "CREATED") {
    return "INFO";
  }
  if (eventType === "DELETED") {
    return "WARN";
  }
  const parsed = parseJsonMaybe(newValue);
  const status = String(parsed?.status || "").toUpperCase();
  if (status === "DONE") {
    return "PASS";
  }
  if (status === "FAILED") {
    return "FAIL";
  }
  if (status === "ARCHIVED") {
    return "WARN";
  }
  if (status === "CLAIMED" || status === "IN_PROGRESS") {
    return "ACTION";
  }
  return eventType === "UPDATED" ? "ACTION" : "INFO";
}

function loadSqliteVec(db) {
  if (!sqliteVec) {
    return false;
  }
  try {
    if (typeof db.enableLoadExtension === "function") {
      db.enableLoadExtension(true);
    }
    sqliteVec.load(db);
    return true;
  } catch (error) {
    console.warn(`[Blackboard] sqlite-vec unavailable; semantic search disabled: ${error.message}`);
    return false;
  }
}

class SwarmBlackboard {
  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new DatabaseSync(DB_PATH, { allowExtension: true });
    this.vectorEnabled = loadSqliteVec(this.db);
    this.initDb();
  }

  initDb() {
    configureBlackboardConnection(this.db);
    this.db.exec(`
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

      CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
        id, type, data, content=tickets
      );
    `);
    ensureProofEventsSchema(this.db);
    if (this.vectorEnabled) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_tickets USING vec0(
            rowid     INTEGER PRIMARY KEY,
            embedding float[${EMBEDDING_DIM}]
          );
        `);
      } catch (error) {
        this.vectorEnabled = false;
        console.warn(`[Blackboard] vec_tickets disabled: ${error.message}`);
      }
    }
  }

  async getEmbedding(text) {
    if (API_KEYS.length === 0) {
      return null;
    }
    for (const apiKey of API_KEYS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
      try {
        const response = await fetch(NVIDIA_ENDPOINT, {
          body: JSON.stringify({
            encoding_format: "float",
            input: [text],
            input_type: "query",
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
          continue;
        }
        const result = await response.json();
        const embedding = result?.data?.[0]?.embedding;
        if (Array.isArray(embedding)) {
          return embedding;
        }
      } catch {
        // Semantic routing is an optimization; ticket creation must stay local.
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  }

  logEvent(ticketId, eventType, agentId, oldValue, newValue, metadata = {}) {
    this.db
      .prepare(
        "INSERT INTO ticket_events (ticket_id, event_type, agent_id, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        ticketId,
        eventType,
        agentId || null,
        oldValue || null,
        newValue || null,
        new Date().toISOString(),
      );
    recordProofEvent(this.db, {
      component: "blackboard",
      eventType: `BLACKBOARD_${eventType}`,
      payload: {
        agentId: agentId || null,
        ...metadata,
        newValue: parseJsonMaybe(newValue) || newValue || null,
        oldValue: parseJsonMaybe(oldValue) || oldValue || null,
      },
      status: resolveProofStatusForTicketEvent(eventType, newValue),
      summary: `Blackboard ticket ${eventType.toLowerCase()}`,
      ticketId,
    });
  }

  async post(type, priority, target, data, ttl) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const parsedData = typeof data === "string" ? data : JSON.stringify(data);
    const agentOsTicket = assertAgentOsTicket({
      createdAt: now,
      data: parsedData,
      id,
      priority,
      status: "OPEN",
      targetAgent: target,
      ttlMinutes: ttl,
      type,
      updatedAt: now,
    });
    this.db
      .prepare(
        "INSERT INTO tickets (id, type, priority, target_agent, status, data, created_at, updated_at, ttl_minutes) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)",
      )
      .run(id, type || "generic", priority || 0, target || null, parsedData, now, now, ttl || 60);
    const row = this.db.prepare("SELECT rowid FROM tickets WHERE id = ?").get(id);
    if (row?.rowid) {
      try {
        this.db
          .prepare("INSERT INTO tickets_fts (rowid, id, type, data) VALUES (?, ?, ?, ?)")
          .run(row.rowid, id, type || "generic", parsedData);
      } catch {}
      this.queueTicketEmbedding(row.rowid);
    }
    this.logEvent(id, "CREATED", null, null, parsedData, { agentOsTicket });
    return id;
  }

  list() {
    return this.db.prepare("SELECT * FROM tickets").all();
  }

  get(id) {
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  }

  history(id) {
    return this.db
      .prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC")
      .all(id);
  }

  async refreshTicketEmbedding(rowid, text) {
    if (!this.vectorEnabled || !rowid) {
      return;
    }
    try {
      const rowidValue = BigInt(rowid);
      this.db.prepare("DELETE FROM vec_tickets WHERE rowid = ?").run(rowidValue);
      const embedding = await this.getEmbedding(text);
      if (embedding) {
        this.db
          .prepare("INSERT INTO vec_tickets (rowid, embedding) VALUES (?, ?)")
          .run(rowidValue, new Float32Array(embedding));
      }
    } catch {}
  }

  async refreshTicketEmbeddingFromRow(rowid) {
    const row = this.db.prepare("SELECT data FROM tickets WHERE rowid = ?").get(rowid);
    if (!row) {
      return;
    }
    await this.refreshTicketEmbedding(rowid, String(row.data ?? ""));
  }

  queueTicketEmbedding(rowid) {
    if (!this.vectorEnabled || !rowid || API_KEYS.length === 0) {
      return;
    }
    const child = spawn(process.execPath, [__filename, "embed", String(rowid)], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
  }

  async update(id, status, data, agentId = null) {
    const ticket = this.get(id);
    if (!ticket) {
      throw new Error(`Ticket ${id} not found`);
    }
    const updates = [];
    const values = [];
    const now = new Date().toISOString();
    let normalizedStatus = null;
    if (status) {
      normalizedStatus = normalizeAgentOsTicketStatus(status);
      updates.push("status = ?");
      values.push(normalizedStatus);
      if (normalizedStatus === "CLAIMED" || normalizedStatus === "IN_PROGRESS") {
        updates.push("claimed_by = ?", "claimed_at = ?");
        values.push(agentId, now);
      }
    }
    const parsedData = data ? (typeof data === "string" ? data : JSON.stringify(data)) : null;
    if (parsedData) {
      updates.push("data = ?");
      values.push(parsedData);
    }
    if (updates.length === 0) {
      return;
    }
    updates.push("updated_at = ?");
    values.push(now, id);
    this.db.prepare(`UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    if (parsedData) {
      try {
        this.db.prepare("UPDATE tickets_fts SET data = ? WHERE id = ?").run(parsedData, id);
      } catch {}
      const row = this.db.prepare("SELECT rowid FROM tickets WHERE id = ?").get(id);
      await this.refreshTicketEmbedding(row?.rowid, parsedData);
    }
    this.logEvent(
      id,
      "UPDATED",
      agentId,
      JSON.stringify(ticket),
      JSON.stringify({ data: parsedData, status: normalizedStatus }),
    );
  }

  deleteTicket(id) {
    const row = this.db.prepare("SELECT rowid FROM tickets WHERE id = ?").get(id);
    const ticket = this.get(id);
    if (ticket) {
      recordProofEvent(this.db, {
        component: "blackboard",
        eventType: "BLACKBOARD_DELETED",
        payload: ticket,
        status: "WARN",
        summary: "Blackboard ticket deleted",
        ticketId: id,
      });
    }
    this.db.prepare("DELETE FROM tickets WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM ticket_events WHERE ticket_id = ?").run(id);
    try {
      this.db.prepare("DELETE FROM tickets_fts WHERE id = ?").run(id);
    } catch {}
    try {
      if (row?.rowid) {
        this.db.prepare("DELETE FROM vec_tickets WHERE rowid = ?").run(BigInt(row.rowid));
      }
    } catch {}
  }

  proofEvents(options = {}) {
    return listProofEvents(this.db, options);
  }

  proofSummary(options = {}) {
    return summarizeProofEvents(this.db, options);
  }

  recordProof(options) {
    return recordProofEvent(this.db, options);
  }
}

function getArg(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

void (async () => {
  const args = process.argv.slice(2);
  const command = args[0];
  try {
    const board = new SwarmBlackboard();
    if (!command) {
      console.log("OpenClaw Swarm Blackboard CLI");
      console.log(
        "Commands: post, list, get, update, delete, history, proof-list, proof-summary, proof-record",
      );
    } else if (command === "post") {
      const id = await board.post(
        getArg(args, "--type"),
        Number.parseInt(getArg(args, "--priority", "0"), 10),
        getArg(args, "--target"),
        getArg(args, "--data", "{}"),
        Number.parseInt(getArg(args, "--ttl", "60"), 10),
      );
      console.log("Ticket created with id:", id);
    } else if (command === "list") {
      console.log(JSON.stringify(board.list(), null, 2));
    } else if (command === "get") {
      if (!args[1]) {
        throw new Error("ticket id required for get");
      }
      console.log(JSON.stringify(board.get(args[1]), null, 2));
    } else if (command === "history") {
      if (!args[1]) {
        throw new Error("ticket id required for history");
      }
      console.log(JSON.stringify(board.history(args[1]), null, 2));
    } else if (command === "proof-list") {
      console.log(
        JSON.stringify(
          board.proofEvents({
            component: getArg(args, "--component"),
            limit: Number.parseInt(getArg(args, "--limit", "100"), 10),
            runId: getArg(args, "--run"),
            ticketId: args[1] || getArg(args, "--ticket"),
          }),
          null,
          2,
        ),
      );
    } else if (command === "proof-summary") {
      console.log(
        JSON.stringify(
          board.proofSummary({
            component: getArg(args, "--component"),
            limit: Number.parseInt(getArg(args, "--limit", "1000"), 10),
            runId: getArg(args, "--run"),
            ticketId: args[1] || getArg(args, "--ticket"),
          }),
          null,
          2,
        ),
      );
    } else if (command === "proof-record") {
      const id = board.recordProof({
        artifactPath: getArg(args, "--artifact"),
        component: getArg(args, "--component", "manual"),
        eventType: getArg(args, "--type", "MANUAL_PROOF"),
        payload: parseJsonMaybe(getArg(args, "--payload")) || getArg(args, "--payload"),
        runId: getArg(args, "--run"),
        status: getArg(args, "--status", "INFO"),
        summary: getArg(args, "--summary"),
        ticketId: getArg(args, "--ticket") || args[1],
      });
      console.log(JSON.stringify({ id }, null, 2));
    } else if (command === "embed") {
      if (!args[1]) {
        throw new Error("rowid required for embed");
      }
      await board.refreshTicketEmbeddingFromRow(args[1]);
    } else if (command === "update") {
      if (!args[1]) {
        throw new Error("ticket id required for update");
      }
      await board.update(
        args[1],
        getArg(args, "--status"),
        getArg(args, "--data"),
        getArg(args, "--agent"),
      );
      console.log("Ticket updated");
    } else if (command === "delete") {
      if (!args[1]) {
        throw new Error("ticket id required for delete");
      }
      board.deleteTicket(args[1]);
      console.log("Ticket deleted");
    } else {
      throw new Error(`Unsupported command: ${command}`);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
})();
