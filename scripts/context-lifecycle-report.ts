#!/usr/bin/env tsx
/**
 * Context Lifecycle Report
 *
 * Reads a context-lifecycle JSONL file and outputs a human-readable summary.
 *
 * Usage:
 *   tsx scripts/context-lifecycle-report.ts <file.jsonl> [--json]
 */
import fs from "node:fs";

type ContextLifecycleRule =
  | "decay:strip_thinking"
  | "decay:summarize_tool_result"
  | "decay:summarize_group"
  | "decay:strip_tool_result"
  | "decay:file_swap"
  | "decay:max_messages"
  | "decay:pass"
  | "prune:soft_trim"
  | "prune:hard_clear"
  | "prune:pass"
  | "compact:memory_flush"
  | "compact:compaction";

interface ContextLifecycleEvent {
  timestamp: string;
  sessionKey: string;
  sessionId: string;
  turn: number;
  rule: ContextLifecycleRule;
  beforeTokens: number;
  beforePct: number;
  freedTokens: number;
  afterTokens: number;
  afterPct: number;
  contextWindow: number;
  details?: Record<string, unknown>;
}

interface RuleStats {
  count: number;
  totalFreed: number;
  maxFreed: number;
  maxBeforePct: number;
}

interface SessionSummary {
  sessionKey: string;
  sessionId: string;
  contextWindow: number;
  eventCount: number;
  firstEvent: string;
  lastEvent: string;
  peakBeforePct: number;
  totalFreed: number;
  rules: Record<string, RuleStats>;
  compactions: number;
}

function parseEvents(filePath: string): ContextLifecycleEvent[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const events: ContextLifecycleEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as ContextLifecycleEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

function groupBySession(events: ContextLifecycleEvent[]): Map<string, ContextLifecycleEvent[]> {
  const groups = new Map<string, ContextLifecycleEvent[]>();
  for (const evt of events) {
    const key = evt.sessionId;
    const arr = groups.get(key);
    if (arr) {
      arr.push(evt);
    } else {
      groups.set(key, [evt]);
    }
  }
  return groups;
}

function summarizeSession(events: ContextLifecycleEvent[]): SessionSummary {
  const first = events[0];
  const last = events[events.length - 1];
  const rules: Record<string, RuleStats> = {};
  let peakBeforePct = 0;
  let totalFreed = 0;
  let compactions = 0;

  for (const evt of events) {
    if (evt.beforePct > peakBeforePct) {
      peakBeforePct = evt.beforePct;
    }
    totalFreed += evt.freedTokens;
    if (evt.rule === "compact:compaction") {
      compactions++;
    }

    const r = rules[evt.rule];
    if (r) {
      r.count++;
      r.totalFreed += evt.freedTokens;
      if (evt.freedTokens > r.maxFreed) {
        r.maxFreed = evt.freedTokens;
      }
      if (evt.beforePct > r.maxBeforePct) {
        r.maxBeforePct = evt.beforePct;
      }
    } else {
      rules[evt.rule] = {
        count: 1,
        totalFreed: evt.freedTokens,
        maxFreed: evt.freedTokens,
        maxBeforePct: evt.beforePct,
      };
    }
  }

  return {
    sessionKey: first.sessionKey,
    sessionId: first.sessionId,
    contextWindow: first.contextWindow,
    eventCount: events.length,
    firstEvent: first.timestamp,
    lastEvent: last.timestamp,
    peakBeforePct,
    totalFreed,
    rules,
    compactions,
  };
}

function formatTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(0)}s`;
  }
  const min = sec / 60;
  if (min < 60) {
    return `${min.toFixed(1)}m`;
  }
  const hr = min / 60;
  return `${hr.toFixed(1)}h`;
}

function printSummary(summary: SessionSummary): void {
  const duration = formatDuration(summary.firstEvent, summary.lastEvent);
  console.log(`\nSession: ${summary.sessionKey}`);
  console.log(`  ID:             ${summary.sessionId}`);
  console.log(`  Context window: ${formatTokens(summary.contextWindow)} tokens`);
  console.log(`  Duration:       ${duration}`);
  console.log(`  Events:         ${summary.eventCount}`);
  console.log(`  Peak usage:     ${summary.peakBeforePct}%`);
  console.log(`  Total freed:    ${formatTokens(summary.totalFreed)} tokens`);
  console.log(`  Compactions:    ${summary.compactions}`);

  const sortedRules = Object.entries(summary.rules).toSorted(
    (a, b) => b[1].totalFreed - a[1].totalFreed,
  );
  if (sortedRules.length > 0) {
    console.log(`  Rules:`);
    for (const [rule, stats] of sortedRules) {
      const freed = formatTokens(stats.totalFreed);
      const maxFreed = formatTokens(stats.maxFreed);
      console.log(
        `    ${rule.padEnd(28)} ${String(stats.count).padStart(4)}x  freed ${freed.padStart(7)} total  max ${maxFreed.padStart(7)}  peak ${stats.maxBeforePct}%`,
      );
    }
  }
}

function printOverview(summaries: SessionSummary[]): void {
  const totalEvents = summaries.reduce((s, x) => s + x.eventCount, 0);
  const totalFreed = summaries.reduce((s, x) => s + x.totalFreed, 0);
  const totalCompactions = summaries.reduce((s, x) => s + x.compactions, 0);
  const peakPct = Math.max(...summaries.map((s) => s.peakBeforePct));

  console.log("=== Context Lifecycle Report ===");
  console.log(`Sessions:     ${summaries.length}`);
  console.log(`Total events: ${totalEvents}`);
  console.log(`Total freed:  ${formatTokens(totalFreed)} tokens`);
  console.log(`Compactions:  ${totalCompactions}`);
  console.log(`Peak usage:   ${peakPct}%`);
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: tsx scripts/context-lifecycle-report.ts <file.jsonl> [--json]");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const events = parseEvents(filePath);
  if (events.length === 0) {
    console.error("No events found in file.");
    process.exit(1);
  }

  const groups = groupBySession(events);
  const summaries = [...groups.values()].map(summarizeSession);

  if (jsonMode) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  printOverview(summaries);
  for (const summary of summaries) {
    printSummary(summary);
  }
}

main();
