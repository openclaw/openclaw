/**
 * Stats aggregator. Reads `<logsDir>/routing.jsonl`, parses each line, and
 * summarizes activity over a window (defaults to the last 7 days).
 *
 * Cost model: we do NOT track real token cost in the log — that requires
 * post-hoc usage records from the provider. Instead we count requests per
 * alias so the user can eyeball mix. Actual dollar savings come from the
 * provider billing dashboards; this summary shows routing distribution.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROUTING_LOG_FILENAME, type LogEntry } from "./logger.js";

export type Window = {
  /** Inclusive start. */
  startMs: number;
  /** Exclusive end. */
  endMs: number;
};

export type AliasStat = {
  alias: string;
  count: number;
};

export type StatsSummary = {
  /** Number of decisions within the window. */
  totalDecisions: number;
  /** Count of rejected decisions. */
  rejected: number;
  /** Escalation count. */
  escalated: number;
  /** Per-alias counts, sorted descending. */
  perAlias: AliasStat[];
  /** Average classifier confidence across non-rejected entries. */
  averageConfidence: number;
  /** Window (echoed for display). */
  window: Window;
};

export function parseEntries(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as LogEntry;
      if (typeof parsed.timestamp === "string") {
        out.push(parsed);
      }
    } catch {
      // Ignore malformed rows — the logger always writes well-formed JSONL,
      // but partial writes on crash could leave a trailing bad line.
    }
  }
  return out;
}

export function filterWindow(entries: readonly LogEntry[], window: Window): LogEntry[] {
  const out: LogEntry[] = [];
  for (const entry of entries) {
    const ms = Date.parse(entry.timestamp);
    if (Number.isNaN(ms)) {
      continue;
    }
    if (ms >= window.startMs && ms < window.endMs) {
      out.push(entry);
    }
  }
  return out;
}

export function summarize(entries: readonly LogEntry[], window: Window): StatsSummary {
  const perAlias = new Map<string, number>();
  let rejected = 0;
  let escalated = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const entry of entries) {
    if (entry.rejected) {
      rejected += 1;
      continue;
    }
    if (entry.escalated) {
      escalated += 1;
    }
    if (entry.alias) {
      perAlias.set(entry.alias, (perAlias.get(entry.alias) ?? 0) + 1);
    }
    if (typeof entry.confidence === "number") {
      confidenceSum += entry.confidence;
      confidenceCount += 1;
    }
  }

  const sortedAliases: AliasStat[] = [...perAlias.entries()]
    .map(([alias, count]) => ({ alias, count }))
    .toSorted((a, b) => b.count - a.count);

  return {
    totalDecisions: entries.length,
    rejected,
    escalated,
    perAlias: sortedAliases,
    averageConfidence: confidenceCount === 0 ? 0 : confidenceSum / confidenceCount,
    window,
  };
}

export type LoadSummaryParams = {
  logsDir: string;
  window: Window;
};

/** Read the log file and return a summary. Missing file → empty summary. */
export async function loadSummary(params: LoadSummaryParams): Promise<StatsSummary> {
  let text = "";
  try {
    text = await readFile(join(params.logsDir, ROUTING_LOG_FILENAME), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  const entries = parseEntries(text);
  const filtered = filterWindow(entries, params.window);
  return summarize(filtered, params.window);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function lastNDaysWindow(n: number, now: Date = new Date()): Window {
  const endMs = now.getTime();
  return {
    startMs: endMs - n * MS_PER_DAY,
    endMs,
  };
}
