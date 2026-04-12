// RI-011 — Rationalization Hit Sink
//
// Persistent daily rollup of rationalization rule matches. Appends to a
// JSON file at the configured path (default: data/rationalization-hits.json
// relative to the workspace). Fire-and-forget — never throws, never blocks.
//
// Schema: { date, rule_id, severity, action, count }[]
// Each entry is a daily rollup keyed by (date × rule_id).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface RationalizationHitRecord {
  date: string;       // YYYY-MM-DD
  rule_id: string;
  severity: string;   // low | medium | high | critical
  action: string;     // warn | require_override | block
  category: string;
  count: number;
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

/** Reset sink path — tests only. */
export function __resetSinkForTest(): void {
  sinkPath = null;
}
