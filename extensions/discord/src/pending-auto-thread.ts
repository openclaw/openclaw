import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * `autoThread: "on-first-message"` keys the session by the thread id up front
 * (Discord gives a thread started from a message the same id as that message),
 * but does not create the Discord thread until something is about to be sent
 * into it. Every outbound path that can target the thread (reply delivery,
 * progress drafts, message-tool sends) resolves its channel through this
 * registry first, so the thread opens with that message already inside it.
 */
type PendingDiscordAutoThread = {
  accountId: string;
  parentChannelId: string;
  create: () => Promise<string | undefined>;
  state: "pending" | "created" | "failed";
  resolved?: Promise<string>;
  dispose?: () => void;
};

const pendingThreads = new Map<string, PendingDiscordAutoThread>();

function getPendingAutoThreadKey(accountId: string, threadId: string): string {
  return JSON.stringify([accountId, threadId]);
}

/**
 * Entries are normally removed as soon as the thread exists. A turn that never sends
 * anything (for example NO_REPLY) leaves its entry behind, so every entry also expires.
 */
const PENDING_AUTO_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

export function registerPendingDiscordAutoThread(params: {
  accountId: string;
  threadId: string;
  parentChannelId: string;
  create: () => Promise<string | undefined>;
}): () => void {
  const key = getPendingAutoThreadKey(params.accountId, params.threadId);

  const entry: PendingDiscordAutoThread = {
    accountId: params.accountId,
    parentChannelId: params.parentChannelId,
    create: params.create,
    state: "pending",
  };

  pendingThreads.set(key, entry);

  let expiry: ReturnType<typeof setTimeout> | undefined;

  const dispose = () => {
    if (expiry) {
      clearTimeout(expiry);
    }

    if (pendingThreads.get(key) === entry) {
      pendingThreads.delete(key);
    }
  };

  expiry = setTimeout(dispose, PENDING_AUTO_THREAD_TTL_MS);
  expiry.unref?.();

  entry.dispose = dispose;

  return dispose;
}

/**
 * Returns the channel a send should actually use. Unknown ids pass through.
 * For a pending thread this creates it once (concurrent callers share the same
 * promise) and returns the thread id, or the parent channel when creation
 * failed so the reply is still delivered, just not in a thread.
 */
export async function resolvePendingDiscordAutoThreadChannel(
  accountId: string,
  channelId: string,
): Promise<string> {
  const entry = pendingThreads.get(getPendingAutoThreadKey(accountId, channelId));

  if (!entry) {
    return channelId;
  }

  entry.resolved ??= entry
    .create()
    .then((createdId) => {
      if (createdId) {
        // The thread exists now, so later sends can target it directly.
        entry.state = "created";
        entry.dispose?.();
        return createdId;
      }

      entry.state = "failed";
      return entry.parentChannelId;
    })
    .catch((err: unknown) => {
      logVerbose(`discord: deferred autoThread creation failed for ${channelId}: ${String(err)}`);
      entry.state = "failed";
      return entry.parentChannelId;
    });

  return await entry.resolved;
}

/** Typing indicators cannot target a thread that does not exist yet; use its parent. */
export function resolveDiscordTypingChannelId(accountId: string, channelId: string): string {
  const entry = pendingThreads.get(getPendingAutoThreadKey(accountId, channelId));

  if (!entry) {
    return channelId;
  }

  return entry.state === "created" ? channelId : entry.parentChannelId;
}
