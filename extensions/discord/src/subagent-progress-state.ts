import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const PROGRESS_STORE_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_TRACKED_RUNS = 4_096;

export type ProgressApi = {
  config: OpenClawConfig;
  logger: { debug?: (message: string) => void };
  runtime?: {
    state: {
      openKeyedStore<T>(options: {
        namespace: string;
        maxEntries: number;
        overflowPolicy: "reject-new";
        defaultTtlMs: number;
      }): PluginStateKeyedStore<T>;
    };
  };
};

export type PersistedProgressRun = {
  /** Plugin SQLite ownership lets an ended run clean reactions after gateway restart. */
  key: string;
  accountId: string;
  channelId: string;
  messageId: string;
  status: "active" | "cleanup";
  runningEmoji?: string;
};

export type ProgressTracker = {
  accountId: string;
  channelId: string;
  messageId: string;
  activeRunIds: Set<string>;
  persistedRunIds: Set<string>;
  runningEmoji?: string;
  runningEmojiConfirmed: boolean;
  reactionsEnabled: boolean;
  typingTimer?: ReturnType<typeof setInterval>;
  typingExpiresAt: number;
};

export type ProgressRunLookupResult =
  | { status: "found"; value: PersistedProgressRun }
  | { status: "missing" }
  | { status: "error" };

export type PersistProgressResult = "persisted" | "terminal" | "conflict" | "error";

type ProgressStateForKeyResult =
  | { ok: true; activeRunIds: string[]; cleanupRunIds: string[]; ownedEmojis: string[] }
  | { ok: false };

let progressStores = new WeakMap<object, PluginStateKeyedStore<PersistedProgressRun> | null>();
const trackerQueues = new Map<string, Promise<void>>();

export function logFailure(api: ProgressApi, action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  api.logger.debug?.(`discord subagent progress ${action} failed: ${message}`);
}

export function getProgressStore(
  api: ProgressApi,
): PluginStateKeyedStore<PersistedProgressRun> | undefined {
  const cached = progressStores.get(api);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  if (!api.runtime?.state) {
    progressStores.set(api, null);
    return undefined;
  }
  try {
    const store = api.runtime.state.openKeyedStore<PersistedProgressRun>({
      namespace: "subagent-progress",
      maxEntries: MAX_TRACKED_RUNS,
      overflowPolicy: "reject-new",
      defaultTtlMs: PROGRESS_STORE_TTL_MS,
    });
    progressStores.set(api, store);
    return store;
  } catch (error) {
    logFailure(api, "state store open", error);
    return undefined;
  }
}

export function persistedProgressRunFromTracker(
  tracker: ProgressTracker,
  status: PersistedProgressRun["status"],
): PersistedProgressRun {
  return {
    key: `${tracker.accountId}:${tracker.channelId}:${tracker.messageId}`,
    accountId: tracker.accountId,
    channelId: tracker.channelId,
    messageId: tracker.messageId,
    status,
    ...(tracker.runningEmoji ? { runningEmoji: tracker.runningEmoji } : {}),
  };
}

export async function persistProgressRun(
  api: ProgressApi,
  runId: string,
  tracker: ProgressTracker,
): Promise<PersistProgressResult> {
  const store = getProgressStore(api);
  if (!store) {
    return "error";
  }
  const value = persistedProgressRunFromTracker(tracker, "active");
  try {
    if (await store.registerIfAbsent(runId, value)) {
      return "persisted";
    }
    const existing = await store.lookup(runId);
    if (!existing) {
      return "error";
    }
    if (existing.status === "cleanup") {
      return "terminal";
    }
    return existing.key === value.key ? "persisted" : "conflict";
  } catch (error) {
    logFailure(api, "state store write", error);
    return "error";
  }
}

export async function markProgressRunForCleanup(
  api: ProgressApi,
  runId: string,
  persisted: PersistedProgressRun,
) {
  try {
    await getProgressStore(api)?.register(runId, { ...persisted, status: "cleanup" });
    return true;
  } catch (error) {
    logFailure(api, "state store cleanup mark", error);
    return false;
  }
}

export async function lookupProgressRun(
  api: ProgressApi,
  runId: string,
): Promise<ProgressRunLookupResult> {
  const store = getProgressStore(api);
  if (!store) {
    return { status: "error" };
  }
  try {
    const value = await store.lookup(runId);
    return value ? { status: "found", value } : { status: "missing" };
  } catch (error) {
    logFailure(api, "state store read", error);
    return { status: "error" };
  }
}

export async function consumeProgressRun(api: ProgressApi, runId: string) {
  try {
    return await getProgressStore(api)?.consume(runId);
  } catch (error) {
    logFailure(api, "state store consume", error);
    return undefined;
  }
}

export async function listProgressStateForKey(
  api: ProgressApi,
  key: string,
): Promise<ProgressStateForKeyResult> {
  const store = getProgressStore(api);
  if (!store) {
    return { ok: false };
  }
  try {
    const entries = await store.entries();
    const matching = entries.filter((entry) => entry.value.key === key);
    return {
      ok: true,
      activeRunIds: matching
        .filter((entry) => entry.value.status === "active")
        .map((entry) => entry.key),
      cleanupRunIds: matching
        .filter((entry) => entry.value.status === "cleanup")
        .map((entry) => entry.key),
      ownedEmojis: Array.from(new Set(matching.flatMap((entry) => entry.value.runningEmoji ?? []))),
    };
  } catch (error) {
    logFailure(api, "state store list", error);
    return { ok: false };
  }
}

export async function runQueued(key: string, task: () => Promise<void>) {
  const previous = trackerQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  trackerQueues.set(key, current);
  try {
    await current;
  } finally {
    if (trackerQueues.get(key) === current) {
      trackerQueues.delete(key);
    }
  }
}

export function resetDiscordSubagentProgressStateForTest() {
  trackerQueues.clear();
  progressStores = new WeakMap();
}
