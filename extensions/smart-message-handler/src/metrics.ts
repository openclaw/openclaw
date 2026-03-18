import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { ExecutionKind } from "./types.ts";

export interface ClassificationMetrics {
  readonly totalClassifications: number;
  readonly kindDistribution: Readonly<Record<ExecutionKind, number>>;
  readonly signalInjected: number;
  readonly skippedSessions: number;
}

interface MutableMetrics {
  totalClassifications: number;
  kindDistribution: Record<ExecutionKind, number>;
  signalInjected: number;
  skippedSessions: number;
}

// ---- JSONL persistence ----

interface MetricsLogEntry {
  readonly t: number; // timestamp
  readonly s: string; // sessionKey
  readonly k: ExecutionKind; // kind
  readonly si: boolean; // signal injected
}

const DEFAULT_LOG_PATH = join(
  process.env.HOME || "",
  ".openclaw/shared-memory/smart-handler-metrics.jsonl",
);

const ALLOWED_PREFIX = join(process.env.HOME || "", ".openclaw/");
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ROTATION_CHECK_INTERVAL = 100;
const FLUSH_INTERVAL_MS = 5000;

let logPath = DEFAULT_LOG_PATH;
let persistEnabled = false;
let writeCount = 0;
let writeBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function enablePersistence(path?: string): void {
  const resolved = resolve(path || DEFAULT_LOG_PATH);
  if (!resolved.startsWith(resolve(ALLOWED_PREFIX))) {
    throw new Error(`Metrics log path must be under ${ALLOWED_PREFIX}`);
  }
  logPath = resolved;
  persistEnabled = true;
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  rotateLogIfNeeded();
}

export function disablePersistence(): void {
  persistEnabled = false;
}

// ---- Async buffered writes ----

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushWriteBuffer();
  }, FLUSH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    (flushTimer as { unref: () => void }).unref();
  }
}

async function flushWriteBuffer(): Promise<void> {
  if (writeBuffer.length === 0 || !persistEnabled) {
    return;
  }
  const batch = writeBuffer.join("");
  writeBuffer = [];
  try {
    await appendFile(logPath, batch);
  } catch {
    // Silent fail
  }
}

export async function flushMetrics(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushWriteBuffer();
}

// ---- Log rotation ----

function rotateLogIfNeeded(): void {
  if (!persistEnabled || !existsSync(logPath)) {
    return;
  }
  try {
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      const keepLines = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(logPath, keepLines.join("\n") + "\n");
    }
  } catch {
    // Silent fail
  }
}

// ---- In-memory metrics ----

let metrics: MutableMetrics = createEmptyMetrics();

function createEmptyMetrics(): MutableMetrics {
  return {
    totalClassifications: 0,
    kindDistribution: {
      search: 0,
      install: 0,
      read: 0,
      run: 0,
      write: 0,
      debug: 0,
      analyze: 0,
      chat: 0,
      unknown: 0,
    },
    signalInjected: 0,
    skippedSessions: 0,
  };
}

export function recordClassification(
  kind: ExecutionKind,
  signalInjected: boolean,
  sessionKey?: string,
): void {
  // In-memory update
  metrics.totalClassifications++;
  metrics.kindDistribution[kind]++;
  if (signalInjected) {
    metrics.signalInjected++;
  }

  // JSONL persistence (async buffered)
  if (persistEnabled) {
    const entry: MetricsLogEntry = {
      t: Date.now(),
      s: sessionKey || "unknown",
      k: kind,
      si: signalInjected,
    };
    writeBuffer.push(JSON.stringify(entry) + "\n");
    scheduleFlush();
    writeCount++;
    if (writeCount % ROTATION_CHECK_INTERVAL === 0) {
      rotateLogIfNeeded();
    }
  }
}

export function recordSkippedSession(): void {
  metrics.skippedSessions++;
}

export function getMetrics(): ClassificationMetrics {
  return { ...metrics, kindDistribution: { ...metrics.kindDistribution } };
}

export function resetMetrics(): void {
  metrics = createEmptyMetrics();
}

export function formatMetricsReport(m: ClassificationMetrics): string {
  const lines = [
    `Total classifications: ${m.totalClassifications}`,
    `Signal injected: ${m.signalInjected} (${pct(m.signalInjected, m.totalClassifications)})`,
    `Skipped sessions: ${m.skippedSessions}`,
    `\nKind distribution:`,
  ];
  for (const [kind, count] of Object.entries(m.kindDistribution)) {
    if (count > 0) {
      lines.push(`  ${kind}: ${count} (${pct(count, m.totalClassifications)})`);
    }
  }
  return lines.join("\n");
}

function pct(n: number, total: number): string {
  if (total === 0) {
    return "0%";
  }
  return `${((n / total) * 100).toFixed(1)}%`;
}

// ---- Persisted metrics query ----

export function loadPersistedMetrics(since?: number): MetricsLogEntry[] {
  if (!existsSync(logPath)) {
    return [];
  }
  try {
    const content = readFileSync(logPath, "utf-8");
    const entries: MetricsLogEntry[] = [];
    const VALID_KINDS = new Set<string>([
      "search",
      "install",
      "read",
      "run",
      "write",
      "debug",
      "analyze",
      "chat",
      "unknown",
    ]);

    for (const line of content.trim().split("\n")) {
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        // Validate entry shape before accepting
        if (
          typeof parsed.t === "number" &&
          typeof parsed.s === "string" &&
          VALID_KINDS.has(parsed.k) &&
          typeof parsed.si === "boolean"
        ) {
          entries.push(parsed as MetricsLogEntry);
        }
        // Skip entries with invalid shape silently
      } catch {
        // Skip malformed lines
      }
    }

    if (since) {
      return entries.filter((e) => e.t >= since);
    }
    return entries;
  } catch {
    return [];
  }
}

export function aggregatePersistedMetrics(entries: MetricsLogEntry[]): ClassificationMetrics {
  const result = createEmptyMetrics();
  for (const e of entries) {
    result.totalClassifications++;
    if (e.k in result.kindDistribution) {
      result.kindDistribution[e.k]++;
    }
    if (e.si) {
      result.signalInjected++;
    }
  }
  return { ...result, kindDistribution: { ...result.kindDistribution } };
}
