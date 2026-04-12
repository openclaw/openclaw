// RI-011 — Rationalization Hit Sink
//
// Two tiers of persistence:
//   1. Daily rollup — { date, rule_id, severity, action, count }[]
//      Used by the MC dashboard for trend charts. Path: rationalization-hits.json
//   2. Per-event log — { event_id, timestamp, rule_id, ..., session context }[]
//      Used for audit drill-down. Path: rationalization-events.json
//
// Both are fire-and-forget — never throw, never block.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RationalizationHitRecord {
  date: string;       // YYYY-MM-DD
  rule_id: string;
  severity: string;   // low | medium | high | critical
  action: string;     // warn | require_override | block
  category: string;
  count: number;
}

/** Per-event record with full session context for audit trail */
export interface RationalizationEvent {
  event_id: string;
  timestamp: string;  // ISO 8601
  rule_id: string;
  severity: string;
  action: string;
  category: string;
  tool_name: string;
  /** First 500 chars of stringified params — enough for audit, not excessive */
  params_snippet: string;
  session_id?: string;
  session_key?: string;
  agent_id?: string;
  /** Snippet of assistant text that triggered the match */
  matched_text_snippet?: string;
}

let sinkPath: string | null = null;

/**
 * Configure where hit records are persisted. Must be called once at startup.
 * If never called, recordHit() is a no-op (safe for tests).
 */
export function configureSinkPath(path: string): void {
  sinkPath = path;
}

/** Read all hit records from disk. Returns empty array if file missing. */
export function loadHits(path?: string): RationalizationHitRecord[] {
  const p = path ?? sinkPath;
  if (!p || !existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Record a rationalization rule match. Increments the daily rollup for
 * the given rule_id. Fire-and-forget — logs to stderr on error, never throws.
 */
export function recordHit(
  ruleId: string,
  severity: string,
  action: string,
  category: string,
): void {
  if (!sinkPath) return;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = loadHits();

    const existing = records.find(
      (r) => r.date === today && r.rule_id === ruleId,
    );

    if (existing) {
      existing.count += 1;
    } else {
      records.push({
        date: today,
        rule_id: ruleId,
        severity,
        action,
        category,
        count: 1,
      });
    }

    mkdirSync(dirname(sinkPath), { recursive: true });
    writeFileSync(sinkPath, JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    // Fire-and-forget — never throw, never block
    process.stderr.write(
      `[rationalization-sink] Failed to record hit for ${ruleId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Record a per-event audit entry with full session context.
 * Fire-and-forget — logs to stderr on error, never throws.
 */
export function recordEvent(params: {
  ruleId: string;
  severity: string;
  action: string;
  category: string;
  toolName: string;
  toolParams: unknown;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  matchedText?: string;
}): void {
  if (!sinkPath) return;

  try {
    const eventsPath = join(dirname(sinkPath), "rationalization-events.json");

    const existing = loadEvents(eventsPath);

    const paramsStr = typeof params.toolParams === "string"
      ? params.toolParams
      : JSON.stringify(params.toolParams ?? "");

    const event: RationalizationEvent = {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      rule_id: params.ruleId,
      severity: params.severity,
      action: params.action,
      category: params.category,
      tool_name: params.toolName,
      params_snippet: paramsStr.slice(0, 500),
      session_id: params.sessionId,
      session_key: params.sessionKey,
      agent_id: params.agentId,
      matched_text_snippet: params.matchedText?.slice(0, 200),
    };

    existing.push(event);

    // Keep at most 10,000 events (trim oldest)
    const MAX_EVENTS = 10_000;
    const trimmed = existing.length > MAX_EVENTS
      ? existing.slice(existing.length - MAX_EVENTS)
      : existing;

    mkdirSync(dirname(eventsPath), { recursive: true });
    writeFileSync(eventsPath, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    process.stderr.write(
      `[rationalization-sink] Failed to record event for ${params.ruleId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** Read all per-event records from disk. Returns empty array if file missing. */
export function loadEvents(path?: string): RationalizationEvent[] {
  const p = path ?? (sinkPath ? join(dirname(sinkPath), "rationalization-events.json") : null);
  if (!p || !existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Reset sink path — tests only. */
export function __resetSinkForTest(): void {
  sinkPath = null;
}
