import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import {
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { codexAppIdentityKey } from "./app-identity.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
  v2,
} from "./protocol.js";

const CODEX_APP_INVENTORY_CACHE_TTL_MS = 60 * 60 * 1_000;
// Codex app/read rejects metadata requests containing more than 100 app IDs.
const CODEX_APP_READ_BATCH_LIMIT = 100;
const MAX_SERIALIZED_ERROR_MESSAGE_LENGTH = 500;

export type CodexAppInventoryRequest = <Method extends "app/installed" | "app/read">(
  method: Method,
  params: CodexAppServerRequestParams<Method>,
) => Promise<CodexAppServerRequestResult<Method>>;

export type CodexAppInventoryCacheKeyInput = {
  codexHome?: string;
  endpoint?: string;
  runtimeIdentity?: Record<string, string | undefined>;
  authProfileId?: string;
  accountId?: string;
  envApiKeyFingerprint?: string;
  appServerVersion?: string;
};

type CodexAppInventoryCacheDiagnostic = {
  message: string;
  atMs: number;
};

export type CodexAppInventorySnapshot = {
  key: string;
  apps: CodexAppServerRequestResult<"app/read">["apps"];
  installedApps: readonly v2.InstalledApp[];
  /** Absent for complete inventory; present for plugin-targeted snapshots. */
  targetAppIds?: readonly string[];
  fetchedAtMs: number;
  expiresAtMs: number;
  revision: number;
  lastError?: CodexAppInventoryCacheDiagnostic;
};

type CodexAppInventoryReadState = "fresh" | "stale" | "missing";

export type CodexAppInventoryCacheRead = {
  state: CodexAppInventoryReadState;
  key: string;
  revision: number;
  snapshot?: CodexAppInventorySnapshot;
  refreshScheduled: boolean;
  diagnostic?: CodexAppInventoryCacheDiagnostic;
};

type CacheEntry = CodexAppInventorySnapshot & {
  invalidated: boolean;
};

type RefreshParams = {
  key: string;
  request: CodexAppInventoryRequest;
  nowMs?: number;
  forceRefetch?: boolean;
  suppressRefresh?: boolean;
  targetAppIds?: readonly string[];
};

type InFlightRefresh = {
  promise: Promise<CodexAppInventorySnapshot>;
  targetAppIds: ReadonlySet<string>;
};

export class CodexAppInventoryCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightRefresh>();
  private readonly diagnostics = new Map<string, CodexAppInventoryCacheDiagnostic>();
  private revision = 0;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? CODEX_APP_INVENTORY_CACHE_TTL_MS;
  }

  read(params: RefreshParams): CodexAppInventoryCacheRead {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    const entry = this.entries.get(params.key);
    const state: CodexAppInventoryReadState = !entry
      ? "missing"
      : entry.invalidated || !isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })
        ? "stale"
        : "fresh";
    const refreshScheduled =
      (state === "missing"
        ? !params.suppressRefresh
        : state === "stale" || Boolean(params.forceRefetch)) && this.scheduleRefresh(params);
    let snapshot: CodexAppInventorySnapshot | undefined;
    if (entry) {
      const { invalidated: _invalidated, ...rest } = entry;
      snapshot = rest;
    }
    const diagnostic = entry ? entry.lastError : this.diagnostics.get(params.key);
    return {
      state,
      key: params.key,
      revision: entry?.revision ?? this.revision,
      ...(snapshot ? { snapshot } : {}),
      refreshScheduled,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  /** Marks a key stale until its next successful refresh. */
  invalidate(key: string, reason: string, nowMs = Date.now()): number {
    this.revision += 1;
    const diagnostic = { message: reason, atMs: nowMs };
    const entry = this.entries.get(key);
    if (entry) {
      entry.invalidated = true;
      entry.lastError = diagnostic;
      entry.revision = this.revision;
    } else {
      this.diagnostics.set(key, diagnostic);
    }
    return this.revision;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.diagnostics.clear();
    this.revision = 0;
  }

  private scheduleRefresh(params: RefreshParams): boolean {
    void this.refreshNow(params).catch(() => undefined);
    return true;
  }

  /** Forces or joins an immediate refresh for a cache key. */
  async refreshNow(params: RefreshParams): Promise<CodexAppInventorySnapshot> {
    const existing = this.inFlight.get(params.key);
    if (existing && !params.forceRefetch && doesInFlightRefreshCover(existing, params)) {
      return existing.promise;
    }

    const previousRefresh = params.forceRefetch ? undefined : existing?.promise;
    const promise = this.refreshUncoalesced(params, previousRefresh);
    const currentRefresh = {
      promise,
      targetAppIds: targetAppIdSet(params.targetAppIds),
    };
    this.inFlight.set(params.key, currentRefresh);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(params.key) === currentRefresh) {
        this.inFlight.delete(params.key);
      }
    }
  }

  private async refreshUncoalesced(
    params: RefreshParams,
    previousRefresh?: Promise<CodexAppInventorySnapshot>,
  ): Promise<CodexAppInventorySnapshot> {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    try {
      let previousRefreshSucceeded = false;
      if (previousRefresh) {
        try {
          await previousRefresh;
          previousRefreshSucceeded = true;
        } catch {
          // A failed narrow read does not seed Codex; let the broader read
          // retry independently and perform the cold refresh when required.
        }
      }
      const inventory = await readInstalledApps(params.request, {
        // A cold upstream connector cache is empty until it is deliberately
        // seeded. Later reads reuse its committed snapshot unless requested.
        forceRefresh:
          params.forceRefetch === true ||
          (!this.entries.has(params.key) && !previousRefreshSucceeded),
        targetAppIds: params.targetAppIds,
      });
      this.revision += 1;
      const expiresAtMs = resolveExpiresAtMsFromDurationMs(this.ttlMs, { nowMs }) ?? 0;
      const snapshot: CodexAppInventorySnapshot = {
        key: params.key,
        apps: inventory.apps,
        installedApps: inventory.installedApps,
        ...(params.targetAppIds?.some(Boolean)
          ? {
              targetAppIds: Array.from(targetAppIdSet(params.targetAppIds)).toSorted(),
            }
          : {}),
        fetchedAtMs: nowMs,
        expiresAtMs,
        revision: this.revision,
      };
      // Invalidation during a pending read is best effort; the next refresh or TTL
      // repairs a snapshot that raced an install or cache clear.
      this.entries.set(params.key, {
        ...resolvePublishedInventorySnapshot(this.entries.get(params.key), snapshot, nowMs),
        invalidated: false,
      });
      this.diagnostics.delete(params.key);
      return snapshot;
    } catch (error) {
      const diagnostic = {
        message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        atMs: nowMs,
      };
      this.diagnostics.set(params.key, diagnostic);
      const entry = this.entries.get(params.key);
      if (entry) {
        entry.lastError = diagnostic;
      }
      embeddedAgentLog.warn("codex app inventory refresh failed", {
        forceRefetch: params.forceRefetch === true,
        keyFingerprint: fingerprintInventoryCacheKey(params.key),
        error: serializeCodexAppInventoryError(error),
      });
      throw error;
    }
  }
}

/**
 * Publish policy for refreshed snapshots. A complete refresh replaces the
 * entry, but a targeted refresh only rewrites its own target rows in place —
 * replacing the whole entry with a narrow snapshot makes agents that share
 * the runtime identity see each other's plugin apps vanish and force a hosted
 * connector refresh per turn. The refreshed snapshot stays authoritative for
 * its target set, so target rows it no longer returns are deleted.
 */
function resolvePublishedInventorySnapshot(
  existing: CodexAppInventorySnapshot | undefined,
  snapshot: CodexAppInventorySnapshot,
  nowMs: number,
): CodexAppInventorySnapshot {
  if (!snapshot.targetAppIds?.length || !existing) {
    return snapshot;
  }
  // Merging preserves rows the refresh never re-read, which is only safe while
  // the existing entry is within TTL. An expired entry is replaced outright so
  // freshness restarts from this refresh; keeping expired rows would pin the
  // entry stale no matter how many targeted refreshes cover it.
  if (!isFutureDateTimestampMs(existing.expiresAtMs, { nowMs })) {
    return snapshot;
  }
  const refreshedTargetIds = new Set(snapshot.targetAppIds);
  const { targetAppIds: snapshotTargetAppIds, ...snapshotBase } = snapshot;
  return {
    ...snapshotBase,
    // Freshness belongs to the still-valid prior fetch: the merge must not
    // renew rows it never re-read.
    fetchedAtMs: existing.fetchedAtMs,
    expiresAtMs: existing.expiresAtMs,
    apps: mergeRefreshedRows(existing.apps, snapshot.apps, refreshedTargetIds),
    installedApps: mergeRefreshedRows(
      existing.installedApps,
      snapshot.installedApps,
      refreshedTargetIds,
    ),
    // A merge into a complete entry keeps the entry complete (no targetAppIds).
    ...(existing.targetAppIds?.length
      ? {
          targetAppIds: Array.from(
            new Set([...existing.targetAppIds, ...snapshotTargetAppIds]),
          ).toSorted(),
        }
      : {}),
  };
}

/** Replaces refreshed target rows in place, deletes vanished ones, appends new ones. */
function mergeRefreshedRows<Row extends { id: string }>(
  existingRows: readonly Row[],
  refreshedRows: readonly Row[],
  refreshedTargetIds: ReadonlySet<string>,
): Row[] {
  const refreshedById = new Map(refreshedRows.map((row) => [codexAppIdentityKey(row.id), row]));
  const existingIds = new Set(existingRows.map((row) => codexAppIdentityKey(row.id)));
  return [
    ...existingRows.flatMap((row) => {
      if (!refreshedTargetIds.has(codexAppIdentityKey(row.id))) {
        return [row];
      }
      const refreshed = refreshedById.get(codexAppIdentityKey(row.id));
      return refreshed ? [refreshed] : [];
    }),
    ...refreshedRows.filter((row) => !existingIds.has(codexAppIdentityKey(row.id))),
  ];
}

function targetAppIdSet(appIds: readonly string[] | undefined): Set<string> {
  return new Set(appIds?.filter(Boolean).map(codexAppIdentityKey) ?? []);
}

function doesInFlightRefreshCover(existing: InFlightRefresh, params: RefreshParams): boolean {
  if (existing.targetAppIds.size === 0) {
    return true;
  }
  const requestedAppIds = targetAppIdSet(params.targetAppIds);
  return (
    requestedAppIds.size > 0 &&
    Array.from(requestedAppIds).every((appId) => existing.targetAppIds.has(appId))
  );
}

export function serializeCodexAppInventoryError(error: unknown): Record<string, unknown> {
  const record = isRecord(error) ? error : undefined;
  const data = record && "data" in record ? redactErrorData(record.data) : undefined;
  return {
    name:
      error instanceof Error
        ? error.name
        : typeof record?.name === "string"
          ? record.name
          : undefined,
    message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    ...(typeof record?.code === "number" ? { code: record.code } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

export const defaultCodexAppInventoryCache = new CodexAppInventoryCache();

export function buildCodexAppInventoryCacheKey(
  input: CodexAppInventoryCacheKeyInput,
  openClawVersion: string,
  codexPluginVersion: string,
): string {
  return JSON.stringify({
    openClawVersion,
    codexPluginVersion,
    codexHome: input.codexHome ?? null,
    endpoint: input.endpoint ?? null,
    runtimeIdentity: normalizeRuntimeIdentityForCacheKey(input.runtimeIdentity),
    authProfileId: input.authProfileId ?? null,
    accountId: input.accountId ?? null,
    envApiKeyFingerprint: input.envApiKeyFingerprint ?? null,
    appServerVersion: input.appServerVersion ?? null,
  });
}

function normalizeRuntimeIdentityForCacheKey(
  value: Record<string, string | undefined> | undefined,
): Record<string, string> | null {
  if (!value) {
    return null;
  }
  const entries = Object.entries(value)
    .flatMap(([key, rawValue]) => {
      const normalized = rawValue?.trim();
      return normalized ? ([[key, normalized]] as const) : [];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

async function readInstalledApps(
  request: CodexAppInventoryRequest,
  options: {
    forceRefresh: boolean;
    targetAppIds?: readonly string[];
  },
): Promise<Pick<CodexAppInventorySnapshot, "apps" | "installedApps">> {
  const installed = await request("app/installed", { forceRefresh: options.forceRefresh });
  const targetIds = targetAppIdSet(options.targetAppIds);
  const apps =
    targetIds.size === 0
      ? installed.apps
      : installed.apps.filter((app) => targetIds.has(codexAppIdentityKey(app.id)));
  if (apps.length === 0) {
    return { apps: [], installedApps: [] };
  }

  const metadataResponses = await Promise.all(
    Array.from({ length: Math.ceil(apps.length / CODEX_APP_READ_BATCH_LIMIT) }, (_, index) =>
      request("app/read", {
        appIds: apps
          .slice(index * CODEX_APP_READ_BATCH_LIMIT, (index + 1) * CODEX_APP_READ_BATCH_LIMIT)
          .map((app) => app.id),
        includeTools: true,
      }),
    ),
  );
  const metadataById = new Map(
    metadataResponses
      .flatMap((response) => response.apps)
      .map((metadata) => [metadata.id, metadata]),
  );

  return {
    apps: apps.flatMap((installedApp) => {
      const metadata = metadataById.get(installedApp.id);
      return metadata ? [metadata] : [];
    }),
    installedApps: apps,
  };
}

function fingerprintInventoryCacheKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function truncateSerializedErrorText(value: string): string {
  return value.length > MAX_SERIALIZED_ERROR_MESSAGE_LENGTH
    ? `${truncateUtf16Safe(value, MAX_SERIALIZED_ERROR_MESSAGE_LENGTH)}...`
    : value;
}

function redactErrorData(value: unknown, depth = 0): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth > 6) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactErrorData(entry, depth + 1) ?? null);
  }
  if (isRecord(value)) {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = /api[_-]?key|authorization|cookie|credential|password|secret|token/i.test(key)
        ? "<redacted>"
        : (redactErrorData(entry, depth + 1) ?? null);
    }
    return redacted;
  }
  if (typeof value === "string") {
    return truncateSerializedErrorText(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return value.name ? `[function ${value.name}]` : "[function]";
  }
  return "[unserializable]";
}

function sanitizeErrorMessage(message: string): string {
  const htmlStart = message.search(/<html[\s>]/i);
  const withoutHtml =
    htmlStart >= 0
      ? `${message.slice(0, htmlStart).trimEnd()} [HTML response body omitted]`
      : message;
  const redacted = withoutHtml.replace(
    /([?&][^=\s"'<>]*(?:api[_-]?key|authorization|cookie|credential|password|secret|token|tk)[^=\s"'<>]*=)[^&\s"'<>]+/gi,
    "$1<redacted>",
  );
  return truncateSerializedErrorText(redacted);
}
