"use strict";

const os = require("node:os");
const path = require("node:path");
const {
  AGENT_OS_PROOF_STATUSES,
  normalizeAgentOsProofEvent,
  normalizeAgentOsProofStatus,
} = require("./agent-os-contracts.cjs");

const DEFAULT_PROOF_EVENT_DB_PATH = path.join(os.homedir(), ".openclaw", "swarm_blackboard.db");
const PROOF_EVENT_STATUSES = AGENT_OS_PROOF_STATUSES;

function normalizeProofEventStatus(status) {
  return normalizeAgentOsProofStatus(status);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = String(value);
  return stringValue.length === 0 ? null : stringValue;
}

function stringifyPayload(payload) {
  if (payload === undefined || payload === null) {
    return null;
  }
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}

function parsePayload(payload) {
  if (payload === undefined || payload === null) {
    return null;
  }
  if (typeof payload !== "string") {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function stripAgentOsProofEvent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  if (!Object.hasOwn(payload, "agentOsProofEvent")) {
    return payload;
  }
  const { agentOsProofEvent: _agentOsProofEvent, ...rest } = payload;
  if (Object.keys(rest).length === 1 && Object.hasOwn(rest, "value")) {
    return rest.value;
  }
  return rest;
}

function ensureProofEventsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proof_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id     TEXT,
      run_id        TEXT,
      event_type    TEXT NOT NULL,
      component     TEXT NOT NULL,
      status        TEXT NOT NULL
                    CHECK(status IN ('INFO','PASS','WARN','FAIL','ACTION')),
      summary       TEXT,
      payload       TEXT,
      artifact_path TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proof_events_ticket_id
      ON proof_events(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_proof_events_run_id
      ON proof_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_proof_events_component
      ON proof_events(component);
    CREATE INDEX IF NOT EXISTS idx_proof_events_created_at
      ON proof_events(created_at);
  `);
}

function recordProofEvent(db, event) {
  ensureProofEventsSchema(db);
  const normalized = normalizeAgentOsProofEvent(event);
  const createdAt = normalized.createdAt;
  const status = normalized.status;
  const artifactPath =
    normalized.artifactRefs.find((artifact) => artifact.path)?.path || event.artifactPath;
  db.prepare(
    `INSERT INTO proof_events (
      ticket_id,
      run_id,
      event_type,
      component,
      status,
      summary,
      payload,
      artifact_path,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    normalizeOptionalString(normalized.ticketId),
    normalizeOptionalString(normalized.runId),
    normalizeOptionalString(normalized.eventType) || "PROOF_EVENT",
    normalizeOptionalString(normalized.component) || "unknown",
    status,
    normalizeOptionalString(normalized.message),
    stringifyPayload({
      ...(normalized.data && typeof normalized.data === "object" && !Array.isArray(normalized.data)
        ? normalized.data
        : { value: normalized.data }),
      agentOsProofEvent: normalized,
    }),
    normalizeOptionalString(artifactPath),
    createdAt,
  );
  const row = db.prepare("SELECT last_insert_rowid() AS id").get();
  return Number(row?.id || 0);
}

function normalizeLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? "100"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 100;
  }
  return Math.min(parsed, 1000);
}

function listProofEvents(db, options = {}) {
  ensureProofEventsSchema(db);
  const where = [];
  const values = [];
  if (options.ticketId) {
    where.push("ticket_id = ?");
    values.push(String(options.ticketId));
  }
  if (options.runId) {
    where.push("run_id = ?");
    values.push(String(options.runId));
  }
  if (options.component) {
    where.push("component = ?");
    values.push(String(options.component));
  }
  const limit = normalizeLimit(options.limit);
  const sql = [
    "SELECT * FROM proof_events",
    where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY id DESC",
    "LIMIT ?",
  ]
    .filter(Boolean)
    .join(" ");
  return db
    .prepare(sql)
    .all(...values, limit)
    .map((row) => {
      const payload = parsePayload(row.payload);
      return Object.assign({}, row, {
        payload: stripAgentOsProofEvent(payload),
        agent_os:
          payload?.agentOsProofEvent ||
          normalizeAgentOsProofEvent({
            artifactPath: row.artifact_path,
            component: row.component,
            createdAt: row.created_at,
            eventType: row.event_type,
            payload,
            runId: row.run_id,
            status: row.status,
            summary: row.summary,
            ticketId: row.ticket_id,
          }),
      });
    });
}

function incrementCount(target, key) {
  const name = String(key || "unknown");
  target[name] = (target[name] || 0) + 1;
}

function summarizeProofEvents(db, options = {}) {
  const events = listProofEvents(db, { ...options, limit: options.limit || 1000 });
  const summary = {
    byComponent: {},
    byEventType: {},
    byStatus: {},
    events: events.length,
    latest: events[0] || null,
    ticketId: options.ticketId || null,
  };
  for (const event of events) {
    incrementCount(summary.byStatus, event.status);
    incrementCount(summary.byComponent, event.component);
    incrementCount(summary.byEventType, event.event_type);
  }
  return summary;
}

module.exports = {
  DEFAULT_PROOF_EVENT_DB_PATH,
  PROOF_EVENT_STATUSES,
  ensureProofEventsSchema,
  listProofEvents,
  normalizeProofEventStatus,
  recordProofEvent,
  summarizeProofEvents,
};
