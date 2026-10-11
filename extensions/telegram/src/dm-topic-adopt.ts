import type { Message } from "grammy/types";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

// Some Telegram clients create a DM topic in threaded mode but deliver the
// user's first message to the root chat: the bot receives a
// `forum_topic_created` service message carrying the new `message_thread_id`,
// then (within the same second) the user's message without any thread id.
// Adopt that message into the freshly created topic so the reply and the
// session land where the user is looking instead of leaving the topic empty.
export const TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC = 3;
const TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES = 512;

type PendingDmTopic = {
  threadId: number;
  date: number;
  createdMessageId: number;
};

export type TelegramDmTopicAdoptState = {
  // Topic created by the user but not yet seen with a message: keyed by chat:user.
  pending: Map<string, PendingDmTopic>;
  // Adopted thread id keyed by chat:message_id so repeated resolution stays stable.
  adopted: Map<string, number>;
};

const log = createSubsystemLogger("telegram/dm-topic-adopt");

export function createTelegramDmTopicAdoptState(): TelegramDmTopicAdoptState {
  return { pending: new Map(), adopted: new Map() };
}

const defaultState = createTelegramDmTopicAdoptState();

export function resetTelegramDmTopicAdoptStateForTest(): void {
  defaultState.pending.clear();
  defaultState.adopted.clear();
}

export function resolveAdoptedTelegramDmThreadId(
  message: Message,
  state: TelegramDmTopicAdoptState = defaultState,
): number | undefined {
  const chat = message.chat;
  if (chat.type !== "private" || typeof chat.id !== "number") {
    return undefined;
  }
  const from = message.from;
  if (!from || typeof from.id !== "number" || from.is_bot === true) {
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
      state.pending.set(userKey, {
        threadId: ownThreadId,
        date: message.date,
        createdMessageId: messageId,
      });
      pruneMapToMaxSize(state.pending, TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES);
    } else if (state.pending.get(userKey)?.threadId === ownThreadId) {
      // The client delivered the first message inside the topic: nothing to adopt.
      state.pending.delete(userKey);
    }
    return undefined;
  }
  const adoptKey = `${chat.id}:${messageId}`;
  const adopted = state.adopted.get(adoptKey);
  if (adopted !== undefined) {
    return adopted;
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
  state.adopted.set(adoptKey, pending.threadId);
  pruneMapToMaxSize(state.adopted, TELEGRAM_DM_TOPIC_ADOPT_MAX_ENTRIES);
  log.debug("adopted root DM message into client-created topic", {
    chatId: chat.id,
    messageId,
    threadId: pending.threadId,
    topicCreatedMessageId: pending.createdMessageId,
    delaySec,
  });
  return pending.threadId;
}
