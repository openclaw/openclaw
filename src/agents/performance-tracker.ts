import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const PERFORMANCE_FILE_PREFIX = "agent-performance-";
const PERFORMANCE_FILE_SUFFIX = ".jsonl";
const PERFORMANCE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenCount = number | null;

export type PerformanceNow = string | number | Date;

export type PerformanceTrackerOptions = {
  stateDir?: string;
  now?: PerformanceNow;
  retentionDays?: number;
};

export type AgentPerformanceOutcome = "success" | "partial" | "failure" | "timeout";

export type CompletionReportMetadata = {
  status?: string;
  confidence?: string;
};

export type PerformanceRecordInput = {
  runId?: string;
  agentId: string;
  taskType?: string;
  spawnerSessionKey?: string;
  startedAt?: PerformanceNow;
  endedAt?: PerformanceNow;
  runtimeMs?: number;
  outcome?: AgentPerformanceOutcome;
  verificationPassed?: boolean;
  completionReport?: CompletionReportMetadata;
  tokens?: {
    input?: TokenCount | undefined;
    output?: TokenCount | undefined;
  };
  inputTokens?: TokenCount | undefined;
  outputTokens?: TokenCount | undefined;
  retryOf?: string;
  escalatedFrom?: string;
  [key: string]: unknown;
};

export type PerformanceRecord = {
  runId: string;
  agentId: string;
  taskType?: string;
  spawnerSessionKey: string;
  startedAt: number;
  endedAt: number;
  runtimeMs: number;
  outcome: AgentPerformanceOutcome;
  verificationPassed?: boolean;
  completionReport?: CompletionReportMetadata;
  tokens: {
    input: TokenCount;
    output: TokenCount;
    total: number;
  };
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  totalTokens: number;
  retryOf?: string;
  escalatedFrom?: string;
  timestampMs: number;
  timestampUtc: string;
};

export type AgentStats = {
  agentId: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  averageRuntimeMs: number;
  outcomes: Record<AgentPerformanceOutcome, number>;
  verification: {
    passed: number;
    failed: number;
    unknown: number;
  };
  completionReports: number;
  latestRunAt?: number;
  latestRunAtUtc?: string;
};

function resolveTrackerNow(now: PerformanceNow | undefined): number {
  const value = now instanceof Date ? now.getTime() : now;
  const resolved = value == null ? Date.now() : new Date(value).getTime();
  if (Number.isNaN(resolved)) {
    throw new Error("Invalid timestamp for performance tracker");
  }
  return resolved;
}

function normalizeTokenCount(value: TokenCount | undefined): TokenCount {
  if (value == null) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function tokenSum(left: TokenCount, right: TokenCount): number {
  return (left ?? 0) + (right ?? 0);
}

function normalizeOutcome(value: unknown): AgentPerformanceOutcome {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "success" ||
    normalized === "partial" ||
    normalized === "failure" ||
    normalized === "timeout"
  ) {
    return normalized;
  }
  return "success";
}

function normalizeCompletionReport(value: unknown): CompletionReportMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const status =
    typeof (value as { status?: unknown }).status === "string"
      ? (value as { status?: string }).status?.trim()
      : undefined;
  const confidence =
    typeof (value as { confidence?: unknown }).confidence === "string"
      ? (value as { confidence?: string }).confidence?.trim()
      : undefined;
  if (!status && !confidence) {
    return undefined;
  }
  return {
    status: status || undefined,
    confidence: confidence || undefined,
  };
}

function resolveEventTimestamp(value: PerformanceNow | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const normalized = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeRuntimeMs(value: unknown, startedAt: number, endedAt: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return Math.max(0, Math.floor(endedAt - startedAt));
}

function formatFileDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function resolveDataDir(stateDir?: string): string {
  const root = stateDir?.trim() ? path.resolve(stateDir) : resolveStateDir(process.env, os.homedir);
  return path.join(root, "data");
}

function resolveFilePath(dateMs: number, stateDir?: string): string {
  const dataDir = resolveDataDir(stateDir);
  const fileDate = formatFileDate(dateMs);
  return path.join(dataDir, `${PERFORMANCE_FILE_PREFIX}${fileDate}${PERFORMANCE_FILE_SUFFIX}`);
}

function parsePerformanceDateFromFile(fileName: string): number | null {
  const match = /^agent-performance-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(fileName);
  if (!match) {
    return null;
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function normalizeRecord(input: PerformanceRecordInput, nowMs: number): PerformanceRecord {
  const endedAt = resolveEventTimestamp(input.endedAt, nowMs);
  const startedAt = resolveEventTimestamp(input.startedAt, endedAt);
  const runtimeMs = normalizeRuntimeMs(input.runtimeMs, startedAt, endedAt);
  const inputTokens = normalizeTokenCount(input.tokens?.input ?? input.inputTokens);
  const outputTokens = normalizeTokenCount(input.tokens?.output ?? input.outputTokens);
  const totalTokens = tokenSum(inputTokens, outputTokens);
  const now = new Date(nowMs);
  const completionReport = normalizeCompletionReport(input.completionReport);
  const runId =
    typeof input.runId === "string" && input.runId.trim()
      ? input.runId.trim()
      : `${input.agentId}-${endedAt}`;
  const spawnerSessionKey =
    typeof input.spawnerSessionKey === "string" && input.spawnerSessionKey.trim()
      ? input.spawnerSessionKey.trim()
      : "unknown";
  const retryOf =
    typeof input.retryOf === "string" && input.retryOf.trim() ? input.retryOf.trim() : undefined;
  const escalatedFrom =
    typeof input.escalatedFrom === "string" && input.escalatedFrom.trim()
      ? input.escalatedFrom.trim()
      : undefined;
  const verificationPassed =
    typeof input.verificationPassed === "boolean" ? input.verificationPassed : undefined;

  return {
    runId,
    agentId: input.agentId,
    taskType:
      typeof input.taskType === "string" && input.taskType.trim()
        ? input.taskType.trim()
        : undefined,
    spawnerSessionKey,
    startedAt,
    endedAt,
    runtimeMs,
    outcome: normalizeOutcome(input.outcome),
    verificationPassed,
    completionReport,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
    },
    inputTokens,
    outputTokens,
    totalTokens,
    retryOf,
    escalatedFrom,
    timestampMs: now.getTime(),
    timestampUtc: now.toISOString(),
    ...Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          ![
            "runId",
            "agentId",
            "taskType",
            "spawnerSessionKey",
            "startedAt",
            "endedAt",
            "runtimeMs",
            "outcome",
            "verificationPassed",
            "completionReport",
            "tokens",
            "inputTokens",
            "outputTokens",
            "retryOf",
            "escalatedFrom",
          ].includes(key),
      ),
    ),
  };
}

function normalizeRetention(retentionDays?: number): number {
  if (!Number.isFinite(retentionDays)) {
    return PERFORMANCE_RETENTION_DAYS;
  }
  return Math.max(0, Math.floor(retentionDays!));
}

export async function cleanupOldPerformanceFiles(
  options: PerformanceTrackerOptions = {},
): Promise<number> {
  const nowMs = resolveTrackerNow(options.now);
  const retentionMs = normalizeRetention(options.retentionDays) * DAY_MS;
  const cutoffMs = nowMs - retentionMs;
  const dataDir = resolveDataDir(options.stateDir);

  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fileDateMs = parsePerformanceDateFromFile(entry);
    if (fileDateMs === null) {
      continue;
    }
    if (fileDateMs >= cutoffMs) {
      continue;
    }
    try {
      await fs.rm(path.join(dataDir, entry), { force: true });
      removed += 1;
    } catch {
      // ignore cleanup errors
    }
  }

  return removed;
}

export async function recordPerformance(
  input: PerformanceRecordInput,
  options: PerformanceTrackerOptions = {},
): Promise<string> {
  const trimmedAgentId = input.agentId?.trim();
  if (!trimmedAgentId) {
    throw new Error("agentId is required");
  }
  const nowMs = resolveTrackerNow(options.now);
  const filePath = resolveFilePath(nowMs, options.stateDir);
  const dataDir = path.dirname(filePath);
  const record = normalizeRecord({ ...input, agentId: trimmedAgentId }, nowMs);
  const line = `${JSON.stringify(record)}\n`;

  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(filePath, line, "utf-8");
  await cleanupOldPerformanceFiles(options);

  return filePath;
}

export const recordAgentPerformance = recordPerformance;

function isPerformanceRecord(value: unknown): value is { agentId: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { agentId?: unknown };
  if (typeof record.agentId !== "string" || !record.agentId.trim()) {
    return false;
  }
  return true;
}

function parseRecordForAggregate(
  value: unknown,
  nowMs: number,
): {
  agentId: string;
  endedAt: number;
  inputTokens: TokenCount;
  outputTokens: TokenCount;
  runtimeMs: number;
  outcome: AgentPerformanceOutcome;
  verificationPassed: boolean | undefined;
  hasCompletionReport: boolean;
} | null {
  if (!isPerformanceRecord(value)) {
    return null;
  }
  const record = value as {
    agentId: string;
    endedAt?: unknown;
    timestampMs?: unknown;
    startedAt?: unknown;
    runtimeMs?: unknown;
    outcome?: unknown;
    verificationPassed?: unknown;
    completionReport?: unknown;
    tokens?: { input?: unknown; output?: unknown };
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  const endedAt = resolveEventTimestamp(
    record.endedAt as PerformanceNow | undefined,
    resolveEventTimestamp(record.timestampMs as PerformanceNow | undefined, nowMs),
  );
  const startedAt = resolveEventTimestamp(record.startedAt as PerformanceNow | undefined, endedAt);
  return {
    agentId: record.agentId,
    endedAt,
    inputTokens: normalizeTokenCount(
      (record.tokens?.input ?? record.inputTokens) as TokenCount | undefined,
    ),
    outputTokens: normalizeTokenCount(
      (record.tokens?.output ?? record.outputTokens) as TokenCount | undefined,
    ),
    runtimeMs: normalizeRuntimeMs(record.runtimeMs, startedAt, endedAt),
    outcome: normalizeOutcome(record.outcome),
    verificationPassed:
      typeof record.verificationPassed === "boolean" ? record.verificationPassed : undefined,
    hasCompletionReport: normalizeCompletionReport(record.completionReport) !== undefined,
  };
}

type MutableAgentStats = AgentStats & {
  runtimeTotalMs: number;
};

function createAgentStats(agentId: string): MutableAgentStats {
  return {
    agentId,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    averageRuntimeMs: 0,
    outcomes: { success: 0, partial: 0, failure: 0, timeout: 0 },
    verification: {
      passed: 0,
      failed: 0,
      unknown: 0,
    },
    completionReports: 0,
    latestRunAt: undefined,
    latestRunAtUtc: undefined,
    runtimeTotalMs: 0,
  };
}

export async function getAgentStats(
  options: PerformanceTrackerOptions = {},
): Promise<Record<string, AgentStats>> {
  const nowMs = resolveTrackerNow(options.now);
  const retentionMs = normalizeRetention(options.retentionDays) * DAY_MS;
  const cutoffMs = nowMs - retentionMs;
  const dataDir = resolveDataDir(options.stateDir);

  const mutable: Record<string, MutableAgentStats> = {};
  let entries: string[] = [];

  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return {};
  }

  for (const entry of entries) {
    const fileDateMs = parsePerformanceDateFromFile(entry);
    if (fileDateMs === null || fileDateMs < cutoffMs) {
      continue;
    }
    const filePath = path.join(dataDir, entry);
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const normalized = parseRecordForAggregate(parsed, nowMs);
      if (!normalized) {
        continue;
      }
      if (normalized.endedAt < cutoffMs) {
        continue;
      }

      const existing = mutable[normalized.agentId] ?? createAgentStats(normalized.agentId);
      existing.requestCount += 1;
      existing.inputTokens += normalized.inputTokens ?? 0;
      existing.outputTokens += normalized.outputTokens ?? 0;
      existing.totalTokens += tokenSum(normalized.inputTokens, normalized.outputTokens);
      existing.runtimeTotalMs += normalized.runtimeMs;
      existing.outcomes[normalized.outcome] += 1;
      if (normalized.verificationPassed === true) {
        existing.verification.passed += 1;
      } else if (normalized.verificationPassed === false) {
        existing.verification.failed += 1;
      } else {
        existing.verification.unknown += 1;
      }
      if (normalized.hasCompletionReport) {
        existing.completionReports += 1;
      }
      if (!existing.latestRunAt || normalized.endedAt > existing.latestRunAt) {
        existing.latestRunAt = normalized.endedAt;
        existing.latestRunAtUtc = new Date(normalized.endedAt).toISOString();
      }
      mutable[normalized.agentId] = existing;
    }
  }

  const out: Record<string, AgentStats> = {};
  for (const [agentId, stats] of Object.entries(mutable)) {
    out[agentId] = {
      agentId: stats.agentId,
      requestCount: stats.requestCount,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      totalTokens: stats.totalTokens,
      averageRuntimeMs:
        stats.requestCount > 0 ? Math.floor(stats.runtimeTotalMs / stats.requestCount) : 0,
      outcomes: stats.outcomes,
      verification: stats.verification,
      completionReports: stats.completionReports,
      latestRunAt: stats.latestRunAt,
      latestRunAtUtc: stats.latestRunAtUtc,
    };
  }

  return out;
}
