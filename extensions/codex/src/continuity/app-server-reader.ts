import { CODEX_CONTROL_METHODS } from "../app-server/capabilities.js";
import { isJsonObject, type JsonValue } from "../app-server/protocol.js";
import { codexControlRequest } from "../command-rpc.js";
import {
  type CodexBridgeCapabilityMap,
  type CodexBridgeGoalState,
  type CodexBridgeThread,
} from "./types.js";

export type AppServerReadResult =
  | {
      ok: true;
      threads: CodexBridgeThread[];
      capabilities: CodexBridgeCapabilityMap;
    }
  | {
      ok: false;
      error: string;
      capabilities: CodexBridgeCapabilityMap;
    };

export async function readCodexThreadsFromAppServer(params: {
  pluginConfig?: unknown;
  config?: unknown;
  limit: number;
  confirmedWriteMethods?: string[];
}): Promise<AppServerReadResult> {
  const capabilities = buildCapabilityMap(params.confirmedWriteMethods ?? []);
  try {
    const response = await codexControlRequest(
      params.pluginConfig,
      CODEX_CONTROL_METHODS.listThreads,
      { limit: params.limit },
      { config: params.config as never },
    );
    capabilities.canInitialize = true;
    capabilities.canListThreads = true;
    return {
      ok: true,
      capabilities,
      threads: normalizeThreadListResponse(response),
    };
  } catch (error) {
    capabilities.warnings.push(formatError(error));
    return { ok: false, error: formatError(error), capabilities };
  }
}

export function buildCapabilityMap(confirmedWriteMethods: string[]): CodexBridgeCapabilityMap {
  const confirmed = new Set(confirmedWriteMethods);
  return {
    canInitialize: false,
    canListThreads: false,
    canReadThread: false,
    canSubscribe: false,
    canStartThread: confirmed.has("thread/start"),
    canStartTurn: confirmed.has("turn/start"),
    canSteerTurn: confirmed.has("turn/steer"),
    canInterruptTurn: confirmed.has("turn/interrupt"),
    confirmedWriteMethods: [...confirmed],
    warnings: confirmed.size > 0 ? [] : ["write methods are not confirmed"],
  };
}

export function normalizeThreadListResponse(response: JsonValue | undefined): CodexBridgeThread[] {
  const entries = extractArrayLike(response);
  return entries
    .map((entry) => normalizeThread(entry))
    .filter((thread): thread is CodexBridgeThread => Boolean(thread));
}

function normalizeThread(entry: JsonValue): CodexBridgeThread | undefined {
  if (!isJsonObject(entry)) {
    return undefined;
  }
  const id = readString(entry, "threadId") ?? readString(entry, "id");
  if (!id) {
    return undefined;
  }
  const goal = normalizeGoal(entry);
  const status = normalizeStatus(
    readString(entry, "status") ??
      readString(entry, "state") ??
      goal?.status ??
      (readBoolean(entry, "active") ? "active" : undefined),
  );
  return {
    id,
    title: readString(entry, "title") ?? readString(entry, "name") ?? readString(entry, "summary"),
    preview: readString(entry, "preview") ?? readString(entry, "firstUserMessage"),
    cwd: readString(entry, "cwd") ?? readString(entry, "workspaceDir"),
    branch: readString(entry, "branch") ?? readString(entry, "gitBranch"),
    model: readString(entry, "model"),
    modelProvider: readString(entry, "modelProvider"),
    source: "app-server",
    stale: false,
    status,
    createdAtMs: readTimeMs(entry, "createdAtMs") ?? readTimeMs(entry, "createdAt"),
    updatedAtMs:
      readTimeMs(entry, "updatedAtMs") ??
      readTimeMs(entry, "updatedAt") ??
      readTimeMs(entry, "lastUpdatedAt"),
    ...(goal ? { goal } : {}),
    raw: entry,
  };
}

function normalizeGoal(entry: Record<string, JsonValue>): CodexBridgeGoalState | undefined {
  const goal = isJsonObject(entry.goal) ? entry.goal : entry;
  const objective =
    readString(goal, "objective") ?? readString(goal, "goal") ?? readString(goal, "goalText");
  const goalId = readString(goal, "goalId") ?? readString(goal, "id");
  const status = readString(goal, "goalStatus") ?? readString(goal, "status");
  if (!objective && !goalId && !status) {
    return undefined;
  }
  return {
    goalKey:
      readString(goal, "goalKey") ??
      `${readString(entry, "id") ?? "thread"}:${objective ?? goalId ?? "goal"}`,
    ...(goalId ? { goalId } : {}),
    ...(objective ? { objective } : {}),
    ...(status ? { status } : {}),
    tokenBudget: readNumber(goal, "tokenBudget"),
    tokensUsed: readNumber(goal, "tokensUsed"),
    timeUsedSeconds: readNumber(goal, "timeUsedSeconds"),
    createdAtMs: readTimeMs(goal, "createdAtMs") ?? readTimeMs(goal, "createdAt"),
    updatedAtMs: readTimeMs(goal, "updatedAtMs") ?? readTimeMs(goal, "updatedAt"),
  };
}

function extractArrayLike(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isJsonObject(value)) {
    return [];
  }
  for (const key of ["threads", "data", "items", "results"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate as JsonValue[];
    }
  }
  return [];
}

function readString(record: Record<string, JsonValue>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, JsonValue>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(record: Record<string, JsonValue>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimeMs(record: Record<string, JsonValue>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeStatus(value: string | undefined): CodexBridgeThread["status"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "active" || normalized === "running") {
    return "active";
  }
  if (normalized === "complete" || normalized === "completed" || normalized === "done") {
    return "complete";
  }
  if (normalized === "paused") {
    return "paused";
  }
  if (normalized === "budget_limited" || normalized === "budget-limited") {
    return "budget_limited";
  }
  if (normalized === "idle") {
    return "idle";
  }
  return "unknown";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
