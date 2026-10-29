import type { TelegramUserbotUpdate } from "./userbot-driver.runtime.js";

type TelegramNativeIdentity = { observer: number; chatId: number; messageId: number };

const nativeKey = (observer: number, chatId: number, messageId: number) =>
  `${observer}:${chatId}:${messageId}`;

/**
 * Maps QA bus message IDs to native Telegram identities in each observer's TDLib namespace.
 * Native identities outlive a bus reset: delayed edits must not become new replies.
 */
export function createTelegramNativeMessageLedger() {
  const nativeMessageIds = new Map<string, TelegramNativeIdentity>();
  const busMessages = new Map<string, { id: string; update?: TelegramUserbotUpdate }>();
  const retiredNativeKeys = new Set<string>();

  return {
    native: (busId: string) => nativeMessageIds.get(busId),
    bus: (observer: number, chatId: number, messageId: number) =>
      busMessages.get(nativeKey(observer, chatId, messageId)),
    record(busId: string, identity: TelegramNativeIdentity, update?: TelegramUserbotUpdate) {
      nativeMessageIds.set(busId, identity);
      busMessages.set(nativeKey(identity.observer, identity.chatId, identity.messageId), {
        id: busId,
        update,
      });
    },
    // TDLib edit updates can omit reply_to; keep the reply target recorded at send time.
    edit(entry: { update?: TelegramUserbotUpdate }, update: TelegramUserbotUpdate) {
      const replyToMessageId = update.replyToMessageId ?? entry.update?.replyToMessageId;
      entry.update = replyToMessageId === undefined ? update : { ...update, replyToMessageId };
    },
    retire: (observer: number, chatId: number, messageId: number) =>
      retiredNativeKeys.add(nativeKey(observer, chatId, messageId)),
    isRetired: (update: TelegramUserbotUpdate, observer: number) =>
      retiredNativeKeys.has(nativeKey(observer, update.chatId, update.messageId)) ||
      (update.replyToMessageId !== undefined &&
        retiredNativeKeys.has(nativeKey(observer, update.chatId, update.replyToMessageId))),
    reset() {
      for (const key of busMessages.keys()) {
        retiredNativeKeys.add(key);
      }
      nativeMessageIds.clear();
      busMessages.clear();
    },
    readUpdates(replyToId?: string) {
      const reply = replyToId === undefined ? undefined : nativeMessageIds.get(replyToId);
      if (replyToId !== undefined && !reply) {
        return [];
      }
      // Correlate in the observer namespace; TDLib IDs are not cross-account identities.
      return [...busMessages.entries()].flatMap(([key, { update }]) =>
        update &&
        (!reply ||
          (update.chatId === reply.chatId &&
            update.replyToMessageId === reply.messageId &&
            key === nativeKey(reply.observer, update.chatId, update.messageId)))
          ? [structuredClone(update)]
          : [],
      );
    },
  };
}
