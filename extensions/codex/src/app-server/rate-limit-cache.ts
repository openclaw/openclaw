/** Client-owned Codex app-server rate-limit snapshots. */
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS = 10 * 60_000;
const SPARSE_ACCOUNT_METADATA_KEYS = ["credits", "individualLimit", "planType"] as const;

type CodexRateLimitCacheState = {
  value: JsonValue;
  updatedAtMs: number;
  revision: number;
};

// The physical client has one notification observer even across same-build module copies.
const rateLimitsByClient = defineCodexBuildState(
  "openclaw.codexAppServerRateLimits",
  () => new WeakMap<CodexAppServerClient, CodexRateLimitCacheState>(),
)();

/** Replaces one physical client's cache with an authoritative rate-limit read response. */
export function rememberCodexRateLimitsRead(
  client: CodexAppServerClient,
  value: JsonValue | undefined,
  nowMs = Date.now(),
): void {
  if (value !== undefined) {
    const currentState = rateLimitsByClient.get(client);
    rateLimitsByClient.set(client, {
      value,
      updatedAtMs: nowMs,
      revision: (currentState?.revision ?? 0) + Number(hasCodexRateLimit(value)),
    });
  }
}

/** Merges a sparse rolling notification into one physical client's latest read response. */
export function mergeCodexRateLimitsUpdate(
  client: CodexAppServerClient,
  value: JsonValue | undefined,
  nowMs = Date.now(),
): void {
  const update =
    isJsonObject(value) && isJsonObject(value.rateLimits) ? value.rateLimits : undefined;
  if (!update) {
    return;
  }
  const currentState = rateLimitsByClient.get(client);
  const current = currentState?.value;
  const limitId = readLimitId(update);
  rateLimitsByClient.set(client, {
    value: mergeRateLimitUpdate(current, update),
    updatedAtMs: nowMs,
    revision: (currentState?.revision ?? 0) + Number(limitId === "codex"),
  });
}

/** Marker used to trust only primary Codex updates from one turn startup. */
export function readCodexRateLimitsRevision(client: CodexAppServerClient): number {
  return rateLimitsByClient.get(client)?.revision ?? 0;
}

/** Reads one physical client's cached rate-limit payload within the max-age window. */
export function readRecentCodexRateLimits(
  client: CodexAppServerClient,
  options?: {
    nowMs?: number;
    maxAgeMs?: number;
  },
): JsonValue | undefined {
  const state = rateLimitsByClient.get(client);
  if (!state) {
    return undefined;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS;
  return maxAgeMs >= 0 && nowMs - state.updatedAtMs > maxAgeMs ? undefined : state.value;
}

function mergeRateLimitUpdate(current: JsonValue | undefined, update: JsonObject): JsonObject {
  const currentEnvelope = isJsonObject(current) ? current : undefined;
  const currentPrimary = readObjectField(currentEnvelope, "rateLimits");
  const currentByLimitId = readObjectField(currentEnvelope, "rateLimitsByLimitId");
  const limitId = readLimitId(update);
  const currentPrimaryLimitId = currentPrimary ? readLimitId(currentPrimary) : undefined;
  const currentForLimit =
    readObjectField(currentByLimitId, limitId) ??
    (currentPrimaryLimitId === limitId ? currentPrimary : undefined);
  const merged: JsonObject = { ...update, limitId };
  // Rolling updates serialize unavailable account metadata as null. Preserve
  // only those sparse fields; window and reached-state nulls remain authoritative.
  for (const key of SPARSE_ACCOUNT_METADATA_KEYS) {
    const previous = currentForLimit?.[key] ?? currentPrimary?.[key];
    if (merged[key] == null && previous != null) {
      merged[key] = previous;
    }
  }
  const nextPrimary =
    !currentPrimary || currentPrimaryLimitId === limitId ? merged : currentPrimary;
  let nextByLimitId: JsonObject | undefined;
  if (currentByLimitId) {
    nextByLimitId = { ...currentByLimitId, [limitId]: merged };
  } else if (currentPrimary && currentPrimaryLimitId && currentPrimaryLimitId !== limitId) {
    nextByLimitId = {
      [currentPrimaryLimitId]: currentPrimary,
      [limitId]: merged,
    };
  }
  return {
    ...currentEnvelope,
    rateLimits: nextPrimary,
    ...(nextByLimitId ? { rateLimitsByLimitId: nextByLimitId } : {}),
  };
}

function hasCodexRateLimit(value: JsonValue): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  if (isJsonObject(value.rateLimits) && readLimitId(value.rateLimits) === "codex") {
    return true;
  }
  if (!isJsonObject(value.rateLimitsByLimitId)) {
    return false;
  }
  return Object.entries(value.rateLimitsByLimitId).some(([key, snapshot]) => {
    const id =
      isJsonObject(snapshot) && typeof snapshot.limitId === "string" ? snapshot.limitId.trim() : "";
    return (id || key) === "codex";
  });
}

function readLimitId(snapshot: JsonObject): string {
  const value = snapshot.limitId;
  return typeof value === "string" && value.trim() ? value.trim() : "codex";
}

function readObjectField(value: JsonObject | undefined, key: string): JsonObject | undefined {
  return value && isJsonObject(value[key]) ? value[key] : undefined;
}
