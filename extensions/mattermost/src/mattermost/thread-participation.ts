// Mattermost plugin module implements thread participation cache behavior.
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalMattermostRuntime } from "../runtime.js";

/**
 * In-memory + persisted cache of Mattermost threads the bot has replied in.
 * Lets the bot auto-respond to thread follow-ups without a re-mention after its
 * first visible reply. Mirrors the Slack `sent-thread-cache` dual-layer pattern.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "mattermost.thread-participation";

type MattermostThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

type MattermostThreadParticipationStore = {
  register(
    key: string,
    value: MattermostThreadParticipationRecord,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<MattermostThreadParticipationRecord | undefined>;
};

/**
 * Keep thread participation shared across bundled chunks so thread auto-reply
 * gating does not diverge between the inbound-gate and reply-dispatch paths.
 */
const MATTERMOST_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.mattermostThreadParticipation");
const threadParticipation = resolveGlobalDedupeCache(MATTERMOST_THREAD_PARTICIPATION_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

let persistentStore: MattermostThreadParticipationStore | undefined;
let persistentStoreDisabled = false;

function makeKey(accountId: string, channelId: string, threadRootId: string): string {
  return `${accountId}:${channelId}:${threadRootId}`;
}

function reportPersistentThreadParticipationError(error: unknown): void {
  try {
    getOptionalMattermostRuntime()
      ?.logging.getChildLogger({ plugin: "mattermost", feature: "thread-participation-state" })
      .warn("Mattermost persistent thread participation state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Mattermost message handling.
  }
}

function disablePersistentThreadParticipation(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentThreadParticipationError(error);
}

function getPersistentThreadParticipationStore(): MattermostThreadParticipationStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalMattermostRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<MattermostThreadParticipationRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentThreadParticipation(error);
    return undefined;
  }
}

function rememberPersistentThreadParticipation(params: { key: string; agentId?: string }): void {
  const store = getPersistentThreadParticipationStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, {
      // Stored for future per-agent thread routing; current reads only need presence.
      ...(params.agentId ? { agentId: params.agentId } : {}),
      repliedAt: Date.now(),
    })
    .catch(disablePersistentThreadParticipation);
}

async function lookupPersistentThreadParticipation(key: string): Promise<boolean> {
  const store = getPersistentThreadParticipationStore();
  if (!store) {
    return false;
  }
  try {
    return Boolean(await store.lookup(key));
  } catch (error) {
    disablePersistentThreadParticipation(error);
    return false;
  }
}

export function recordMattermostThreadParticipation(
  accountId: string,
  channelId: string,
  threadRootId: string,
  opts?: { agentId?: string },
): void {
  if (!accountId || !channelId || !threadRootId) {
    return;
  }
  const key = makeKey(accountId, channelId, threadRootId);
  threadParticipation.check(key);
  rememberPersistentThreadParticipation({ key, agentId: opts?.agentId });
}

export async function hasMattermostThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadRootId: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadRootId) {
    return false;
  }
  const key = makeKey(params.accountId, params.channelId, params.threadRootId);
  if (threadParticipation.peek(key)) {
    return true;
  }
  const found = await lookupPersistentThreadParticipation(key);
  if (found) {
    threadParticipation.check(key);
  }
  return found;
}

export function clearMattermostThreadParticipationCache(): void {
  threadParticipation.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
}
