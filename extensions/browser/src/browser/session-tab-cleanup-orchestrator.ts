/**
 * Cleanup scheduling and lifecycle-over-sweep concurrency policy.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CleanupKind = "lifecycle" | "sweep";

type InFlightCleanup = {
  kind: CleanupKind;
  promise: Promise<number>;
};

type CleanupCandidate = {
  kind: "durable" | "volatile";
  sessionKey: string;
  trackedAt: number;
  lastUsedAt: number;
  cleanupAttemptToken?: string;
  storageKey?: string;
};

const cleanupInFlightSymbol = Symbol.for("openclaw.browser.session-tabs.cleanup-in-flight");

function cleanupInFlight(): Map<string, InFlightCleanup> {
  const state = globalThis as typeof globalThis & {
    [cleanupInFlightSymbol]?: Map<string, InFlightCleanup>;
  };
  state[cleanupInFlightSymbol] ??= new Map();
  return state[cleanupInFlightSymbol];
}

function startCleanup<T>(params: {
  key: string;
  kind: CleanupKind;
  candidate: T;
  run: (candidate: T) => Promise<number>;
}): Promise<number> {
  const inFlight = cleanupInFlight();
  const promise = params.run(params.candidate).finally(() => {
    if (inFlight.get(params.key)?.promise === promise) {
      inFlight.delete(params.key);
    }
  });
  inFlight.set(params.key, { kind: params.kind, promise });
  return promise;
}

export async function runCleanupWithLifecyclePriority<T>(params: {
  key: string;
  kind: CleanupKind;
  candidate: T;
  run: (candidate: T) => Promise<number>;
  reread: () => T | undefined;
  upgradeLifecycle?: (candidate: T) => void;
  retireAlreadyClosed?: (candidate: T) => void;
}): Promise<number> {
  const current = cleanupInFlight().get(params.key);
  if (!current) {
    return await startCleanup(params);
  }
  if (params.kind === "sweep") {
    return 0;
  }
  if (current.kind === "sweep") {
    // Upgrade before waiting so touch cannot revoke the mandatory lifecycle close.
    params.upgradeLifecycle?.(params.candidate);
  }
  const closed = await current.promise;
  const candidate = params.reread();
  if (!candidate) {
    return 0;
  }
  if (closed > 0) {
    // The earlier close succeeded but its stale token could not delete the row.
    params.retireAlreadyClosed?.(candidate);
    return 0;
  }
  return await runCleanupWithLifecyclePriority({ ...params, candidate });
}

export function isIgnorableTabCloseError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(error));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target")
  );
}

export async function closeTrackedTabBatch<T extends { kind: "durable" | "volatile" }>(params: {
  tabs: T[];
  volatileIdentity: (tab: T) => string;
  close: (tab: T) => Promise<number>;
  hasVolatile: (tab: T) => boolean;
  removeVolatile: (tab: T) => void;
}): Promise<number> {
  const unique: T[] = [];
  const volatileDuplicates = new Map<string, T[]>();
  const seenVolatile = new Set<string>();
  for (const tab of params.tabs) {
    if (tab.kind === "durable") {
      unique.push(tab);
      continue;
    }
    const key = params.volatileIdentity(tab);
    if (!seenVolatile.has(key)) {
      seenVolatile.add(key);
      unique.push(tab);
      continue;
    }
    const duplicates = volatileDuplicates.get(key) ?? [];
    duplicates.push(tab);
    volatileDuplicates.set(key, duplicates);
  }
  let closed = 0;
  for (const tab of unique) {
    closed += await params.close(tab);
    if (tab.kind === "volatile" && !params.hasVolatile(tab)) {
      for (const duplicate of volatileDuplicates.get(params.volatileIdentity(tab)) ?? []) {
        params.removeVolatile(duplicate);
      }
    }
  }
  return closed;
}

export function selectStaleTrackedTabs<T extends CleanupCandidate>(params: {
  tabs: T[];
  now: number;
  idleMs?: number;
  maxTabsPerSession?: number;
  sessionFilter?: (sessionKey: string) => boolean;
  identity: (tab: T) => string;
}): T[] {
  const selected = new Map<string, T>();
  const activeBySession = new Map<string, T[]>();
  for (const tab of params.tabs) {
    if (tab.kind === "durable" && tab.cleanupAttemptToken) {
      selected.set(params.identity(tab), tab);
      continue;
    }
    if (params.sessionFilter && !params.sessionFilter(tab.sessionKey)) {
      continue;
    }
    const active = activeBySession.get(tab.sessionKey) ?? [];
    active.push(tab);
    activeBySession.set(tab.sessionKey, active);
  }
  for (const tabs of activeBySession.values()) {
    tabs.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.trackedAt - b.trackedAt);
    if (params.idleMs && params.idleMs > 0) {
      for (const tab of tabs) {
        if (params.now - tab.lastUsedAt >= params.idleMs) {
          selected.set(params.identity(tab), tab);
        }
      }
    }
    const remaining = tabs.filter((tab) => !selected.has(params.identity(tab)));
    const cap = params.maxTabsPerSession;
    if (cap && cap > 0 && remaining.length > cap) {
      for (const tab of remaining.slice(0, remaining.length - cap)) {
        selected.set(params.identity(tab), tab);
      }
    }
  }
  return [...selected.values()];
}
