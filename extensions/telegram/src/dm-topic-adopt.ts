import type { Message } from "grammy/types";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

// Some Telegram clients create a DM topic in threaded mode but deliver the
// user's first message to the root chat: the bot receives a
// `forum_topic_created` service message carrying the new `message_thread_id`,
// then (within the same second) the user's message without any thread id.
// The receiving bot account's ingress monitor decides once, at admission,
// whether a root message belongs to the topic its author just created. The
// decision is recorded on the message object and persisted in the durable
// spool payload, so lane keys, authorization, sessions, delivery and restart
// replay all read the same topic fact instead of re-deriving it.
export const TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC = 3;
const TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES = 512;

type PendingDmTopic = {
  threadId: number;
  date: number;
  createdMessageId: number;
};

/** Adoption state of one bot account; owned by that account's ingress monitor. */
export type TelegramDmTopicAdoptState = {
  // Topic created by the user but not yet seen with a message: keyed by chat:user.
  pending: Map<string, PendingDmTopic>;
  // Service messages whose adoption window was spent: keyed by chat:createdMessageId.
  consumed: Map<string, number>;
};

type TelegramDmTopicMessage = Pick<
  Message,
  "chat" | "date" | "forum_topic_created" | "from" | "message_id" | "message_thread_id"
>;

const log = createSubsystemLogger("telegram/dm-topic-adopt");
// Adopted thread id keyed by the message object the decision was made for.
const adoptedDmThreadIds = new WeakMap<object, number>();

export function createTelegramDmTopicAdoptState(): TelegramDmTopicAdoptState {
  return { pending: new Map(), consumed: new Map() };
}

export function getTelegramAdoptedDmThreadId(message: object): number | undefined {
  return adoptedDmThreadIds.get(message);
}

function resolveTelegramUpdateMessage(update: unknown): object | undefined {
  // SAFETY: Spooled updates are untyped JSON; only an object-valued `message` is used.
  const message = (update as { message?: unknown } | null)?.message;
  return message !== null && typeof message === "object" ? message : undefined;
}

/** Adopted thread id of a spooled update, for its durable payload. */
export function readTelegramAdoptedDmThreadId(update: unknown): number | undefined {
  const message = resolveTelegramUpdateMessage(update);
  return message ? adoptedDmThreadIds.get(message) : undefined;
}

/** Restore a persisted decision onto a replayed update before lane inspection. */
export function restoreTelegramAdoptedDmThreadId(update: unknown, threadId: unknown): void {
  const message = resolveTelegramUpdateMessage(update);
  const parsed = parseStrictPositiveInteger(threadId);
  if (message && parsed !== undefined && !adoptedDmThreadIds.has(message)) {
    adoptedDmThreadIds.set(message, parsed);
  }
}

/** Decide once, at admission, whether a spooled update's message joins a fresh topic. */
export function adoptTelegramDmTopicUpdate(
  update: unknown,
  state: TelegramDmTopicAdoptState,
): number | undefined {
  const message = resolveTelegramUpdateMessage(update);
  if (!message) {
    return undefined;
  }
  // SAFETY: Every field read below is type-checked before use (chat, from, ids, date).
  return adoptTelegramDmTopicMessage(message as TelegramDmTopicMessage, state);
}

/**
 * Idempotent per message object and per service message: resolving either
 * update again never rearms the adoption window.
 */
export function adoptTelegramDmTopicMessage(
  message: TelegramDmTopicMessage,
  state: TelegramDmTopicAdoptState,
): number | undefined {
  const recorded = adoptedDmThreadIds.get(message);
  if (recorded !== undefined) {
    return recorded;
  }
  const chat = message.chat;
  if (chat?.type !== "private" || typeof chat.id !== "number") {
    return undefined;
  }
  const from = message.from;
  if (!from || typeof from.id !== "number" || from.is_bot) {
    return undefined;
  }
  const messageId = message.message_id;
  if (!Number.isSafeInteger(messageId)) {
    return undefined;
  }
  const userKey = `${chat.id}:${from.id}`;
  const ownThreadId = parseStrictPositiveInteger(message.message_thread_id);
  if (ownThreadId !== undefined) {
    if (message.forum_topic_created && typeof message.date === "number") {
      if (!state.consumed.has(`${chat.id}:${messageId}`)) {
        state.pending.set(userKey, {
          threadId: ownThreadId,
          date: message.date,
          createdMessageId: messageId,
        });
        pruneMapToMaxSize(state.pending, TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES);
      }
    } else if (state.pending.get(userKey)?.threadId === ownThreadId) {
      // The client delivered the first message inside the topic: nothing to adopt.
      state.pending.delete(userKey);
    }
    return undefined;
  }
  const pending = state.pending.get(userKey);
  if (!pending || typeof message.date !== "number") {
    return undefined;
  }
  const delaySec = message.date - pending.date;
  if (
    delaySec < 0 ||
    delaySec > TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC ||
    messageId <= pending.createdMessageId
  ) {
    return undefined;
  }
  state.pending.delete(userKey);
  state.consumed.set(`${chat.id}:${pending.createdMessageId}`, messageId);
  pruneMapToMaxSize(state.consumed, TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES);
  adoptedDmThreadIds.set(message, pending.threadId);
  log.debug("adopted root DM message into client-created topic", {
    chatId: chat.id,
    messageId,
    threadId: pending.threadId,
    topicCreatedMessageId: pending.createdMessageId,
    delaySec,
  });
  return pending.threadId;
}
