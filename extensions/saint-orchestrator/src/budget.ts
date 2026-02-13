import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { TOOL_COST_USD } from "./constants.js";
import { parseJsonSafe, readFileIfExists } from "./normalize.js";
import type { UsageLogEntry } from "./types.js";

// In-memory budget tracker to prevent TOCTOU races on concurrent tool calls.
// Key: "workspaceDir::userSlug::dayPrefix", value: running total in USD.
const budgetTracker = new Map<string, number>();
type BudgetReservation = {
  id: string;
  amount: number;
  createdAtMs: number;
};
// Key: "workspaceDir::userSlug::dayPrefix", value: signature -> queue of reservations.
const budgetReservations = new Map<string, Map<string, BudgetReservation[]>>();
const BUDGET_CACHE_CLEANUP_INTERVAL_MS = 300_000; // 5 minutes
const BUDGET_RESERVATION_TTL_MS = 10 * 60 * 1000;
let lastBudgetCleanupMs = Date.now();

function getBudgetKey(workspaceDir: string, userSlug: string, dayPrefix: string): string {
  return `${workspaceDir}::${userSlug}::${dayPrefix}`;
}

export async function getBudgetSpent(workspaceDir: string, userSlug: string, dayPrefix: string): Promise<number> {
  const key = getBudgetKey(workspaceDir, userSlug, dayPrefix);
  const cached = budgetTracker.get(key);
  if (cached !== undefined) {
    return cached;
  }
  // Cold start: read from file
  const fromFile = await readUsageForDay({ workspaceDir, userSlug, dayPrefix });
  budgetTracker.set(key, fromFile);
  return fromFile;
}

export function addBudgetSpent(workspaceDir: string, userSlug: string, dayPrefix: string, amount: number): void {
  const key = getBudgetKey(workspaceDir, userSlug, dayPrefix);
  const current = budgetTracker.get(key) ?? 0;
  budgetTracker.set(key, current + amount);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildBudgetReservationSignature(params: {
  sessionKey?: string;
  toolName: string;
  params?: Record<string, unknown>;
}): string {
  const hash = createHash("sha256")
    .update(`${params.sessionKey ?? "no-session"}|${params.toolName}|${stableSerialize(params.params ?? {})}`)
    .digest("hex")
    .slice(0, 16);
  return `${params.sessionKey ?? "no-session"}::${params.toolName}::${hash}`;
}

function pruneExpiredReservationsForKey(
  entries: BudgetReservation[],
  now: number,
): BudgetReservation[] {
  return entries.filter((entry) => now - entry.createdAtMs <= BUDGET_RESERVATION_TTL_MS);
}

export function getReservedBudgetSpent(
  workspaceDir: string,
  userSlug: string,
  dayPrefix: string,
): number {
  const budgetKey = getBudgetKey(workspaceDir, userSlug, dayPrefix);
  const bySignature = budgetReservations.get(budgetKey);
  if (!bySignature) {
    return 0;
  }
  const now = Date.now();
  let total = 0;
  for (const [signature, entries] of bySignature.entries()) {
    const fresh = pruneExpiredReservationsForKey(entries, now);
    if (fresh.length === 0) {
      bySignature.delete(signature);
      continue;
    }
    bySignature.set(signature, fresh);
    for (const entry of fresh) {
      total += entry.amount;
    }
  }
  if (bySignature.size === 0) {
    budgetReservations.delete(budgetKey);
  }
  return total;
}

export function reserveBudgetSpend(params: {
  workspaceDir: string;
  userSlug: string;
  dayPrefix: string;
  signature: string;
  amount: number;
}): string {
  const budgetKey = getBudgetKey(params.workspaceDir, params.userSlug, params.dayPrefix);
  const bySignature = budgetReservations.get(budgetKey) ?? new Map<string, BudgetReservation[]>();
  const queue = bySignature.get(params.signature) ?? [];
  const reservation: BudgetReservation = {
    id: randomUUID(),
    amount: params.amount,
    createdAtMs: Date.now(),
  };
  queue.push(reservation);
  bySignature.set(params.signature, queue);
  budgetReservations.set(budgetKey, bySignature);
  return reservation.id;
}

export function settleBudgetReservation(params: {
  workspaceDir: string;
  userSlug: string;
  dayPrefix: string;
  signature: string;
}): number {
  const budgetKey = getBudgetKey(params.workspaceDir, params.userSlug, params.dayPrefix);
  const bySignature = budgetReservations.get(budgetKey);
  if (!bySignature) {
    return 0;
  }
  const queue = bySignature.get(params.signature);
  if (!queue || queue.length === 0) {
    return 0;
  }
  const fresh = pruneExpiredReservationsForKey(queue, Date.now());
  if (fresh.length === 0) {
    bySignature.delete(params.signature);
    if (bySignature.size === 0) {
      budgetReservations.delete(budgetKey);
    }
    return 0;
  }
  const entry = fresh.shift();
  if (!entry) {
    bySignature.delete(params.signature);
    if (bySignature.size === 0) {
      budgetReservations.delete(budgetKey);
    }
    return 0;
  }
  if (fresh.length === 0) {
    bySignature.delete(params.signature);
  } else {
    bySignature.set(params.signature, fresh);
  }
  if (bySignature.size === 0) {
    budgetReservations.delete(budgetKey);
  }
  addBudgetSpent(params.workspaceDir, params.userSlug, params.dayPrefix, entry.amount);
  return entry.amount;
}

export function cleanupBudgetCache(today: string): void {
  const now = Date.now();
  if (now - lastBudgetCleanupMs > BUDGET_CACHE_CLEANUP_INTERVAL_MS) {
    lastBudgetCleanupMs = now;
    for (const key of budgetTracker.keys()) {
      if (!key.endsWith(`::${today}`)) {
        budgetTracker.delete(key);
      }
    }
    for (const [budgetKey, bySignature] of budgetReservations.entries()) {
      if (!budgetKey.endsWith(`::${today}`)) {
        budgetReservations.delete(budgetKey);
        continue;
      }
      for (const [signature, entries] of bySignature.entries()) {
        const fresh = pruneExpiredReservationsForKey(entries, now);
        if (fresh.length === 0) {
          bySignature.delete(signature);
        } else {
          bySignature.set(signature, fresh);
        }
      }
      if (bySignature.size === 0) {
        budgetReservations.delete(budgetKey);
      }
    }
  }
}

export function estimateToolCostUsd(toolName: string): number {
  return TOOL_COST_USD[toolName] ?? 0.001;
}

const LOG_SENSITIVE_FIELDS = new Set(["content", "newText", "new_string", "text", "body"]);
const LOG_MAX_COMMAND_LENGTH = 500;

export function sanitizeParamsForLog(
  toolName: string,
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!params) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (LOG_SENSITIVE_FIELDS.has(key)) {
      out[key] = typeof value === "string" ? `[${value.length} chars]` : "[redacted]";
    } else if (key === "command" && typeof value === "string" && value.length > LOG_MAX_COMMAND_LENGTH) {
      out[key] = value.slice(0, LOG_MAX_COMMAND_LENGTH) + "...[truncated]";
    } else if (key === "path" || key === "file_path") {
      out[key] = value; // keep paths — they are useful for audit
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function appendUsageLog(workspaceDir: string, payload: UsageLogEntry) {
  const logsDir = path.join(workspaceDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const line = `${JSON.stringify(payload)}\n`;
  await fs.appendFile(path.join(logsDir, "usage.jsonl"), line, "utf-8");
  const dayPrefix = payload.ts.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayPrefix)) {
    await fs.appendFile(path.join(logsDir, `usage.${dayPrefix}.jsonl`), line, "utf-8").catch(() => undefined);
  }
}

export function utcDayPrefix(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function readUsageForDay(params: {
  workspaceDir: string;
  userSlug: string;
  dayPrefix: string;
}): Promise<number> {
  const dayFilePath = path.join(params.workspaceDir, "logs", `usage.${params.dayPrefix}.jsonl`);
  const dayRaw = await readFileIfExists(dayFilePath);
  if (dayRaw) {
    return sumUsageForDayFromRaw({
      raw: dayRaw,
      userSlug: params.userSlug,
      dayPrefix: params.dayPrefix,
    });
  }

  const usageFilePath = path.join(params.workspaceDir, "logs", "usage.jsonl");
  const usageRaw = await readFileIfExists(usageFilePath);
  if (!usageRaw) {
    return 0;
  }
  const linesForDay: string[] = [];
  const total = sumUsageForDayFromRaw({
    raw: usageRaw,
    userSlug: params.userSlug,
    dayPrefix: params.dayPrefix,
    onDayEntry: (line) => linesForDay.push(line),
  });
  if (linesForDay.length > 0) {
    await fs
      .appendFile(dayFilePath, `${linesForDay.join("\n")}\n`, "utf-8")
      .catch(() => undefined);
  }
  return total;
}

function sumUsageForDayFromRaw(params: {
  raw: string;
  userSlug: string;
  dayPrefix: string;
  onDayEntry?: (line: string) => void;
}): number {
  let total = 0;
  for (const line of params.raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseJsonSafe<UsageLogEntry>(line);
    if (!parsed) {
      continue;
    }
    if (parsed.user !== params.userSlug) {
      continue;
    }
    if (!parsed.ts.startsWith(params.dayPrefix)) {
      continue;
    }
    params.onDayEntry?.(line);
    if (typeof parsed.estimatedCostUsd !== "number" || !Number.isFinite(parsed.estimatedCostUsd)) {
      continue;
    }
    total += parsed.estimatedCostUsd;
  }
  return total;
}
