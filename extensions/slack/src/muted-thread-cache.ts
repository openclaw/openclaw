import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Per-thread mute state for Slack. Recorded when a user asks the bot to stop
 * responding in a shared thread. The persistent layer never expires so the
 * mute survives restarts and long-quiet threads; the in-memory dedupe cache
 * is only a hot-path accelerator and may evict entries safely.
 *
 * Mute is cleared by an explicit @mention of the bot — see `prepareSlackMessage`.
 */

const HOT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; persistent store is the source of truth
const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 5000;
const PERSISTENT_NAMESPACE = "slack.thread-mute";

type SlackThreadMuteRecord = {
  agentId?: string;
  mutedAt: number;
};

type SlackThreadMuteStore = {
  register(key: string, value: SlackThreadMuteRecord, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<SlackThreadMuteRecord | undefined>;
  delete(key: string): Promise<boolean>;
};

const SLACK_THREAD_MUTE_KEY = Symbol.for("openclaw.slackThreadMute");
const muteHotCache = resolveGlobalDedupeCache(SLACK_THREAD_MUTE_KEY, {
  ttlMs: HOT_CACHE_TTL_MS,
  maxSize: MAX_ENTRIES,
});

let persistentStore: SlackThreadMuteStore | undefined;
let persistentStoreDisabled = false;

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function reportPersistentMuteError(error: unknown): void {
  try {
    getOptionalSlackRuntime()
      ?.logging.getChildLogger({ plugin: "slack", feature: "thread-mute-state" })
      .warn("Slack persistent thread mute state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Slack message handling.
  }
}

function disablePersistentMute(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentMuteError(error);
}

function getPersistentMuteStore(): SlackThreadMuteStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<SlackThreadMuteRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      // No defaultTtlMs: mute persists until the user re-engages by tagging the bot.
    });
    return persistentStore;
  } catch (error) {
    disablePersistentMute(error);
    return undefined;
  }
}

function rememberPersistentMute(params: { key: string; agentId?: string }): void {
  const store = getPersistentMuteStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      mutedAt: Date.now(),
    })
    .catch(disablePersistentMute);
}

async function deletePersistentMute(key: string): Promise<void> {
  const store = getPersistentMuteStore();
  if (!store) {
    return;
  }
  try {
    await store.delete(key);
  } catch (error) {
    disablePersistentMute(error);
  }
}

function isMuteRecord(value: unknown): value is SlackThreadMuteRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { mutedAt?: unknown }).mutedAt === "number"
  );
}

async function lookupPersistentMute(key: string): Promise<boolean> {
  const store = getPersistentMuteStore();
  if (!store) {
    return false;
  }
  try {
    return isMuteRecord(await store.lookup(key));
  } catch (error) {
    disablePersistentMute(error);
    return false;
  }
}

export function recordSlackThreadMute(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  agentId?: string;
}): void {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return;
  }
  const key = makeKey(params.accountId, params.channelId, params.threadTs);
  muteHotCache.check(key);
  rememberPersistentMute({ key, agentId: params.agentId });
}

export async function clearSlackThreadMute(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
}): Promise<void> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return;
  }
  const key = makeKey(params.accountId, params.channelId, params.threadTs);
  muteHotCache.delete(key);
  await deletePersistentMute(key);
}

export async function isSlackThreadMutedWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return false;
  }
  const key = makeKey(params.accountId, params.channelId, params.threadTs);
  if (muteHotCache.peek(key)) {
    return true;
  }
  const found = await lookupPersistentMute(key);
  if (found) {
    muteHotCache.check(key);
  }
  return found;
}

export function clearSlackThreadMuteCache(): void {
  muteHotCache.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
}
