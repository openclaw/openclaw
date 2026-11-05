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
      const updates = [...busMessages.entries()];
      if (replyToId === undefined) {
        return updates.flatMap(([, { update }]) => (update ? [structuredClone(update)] : []));
      }
      const reply = nativeMessageIds.get(replyToId);
      if (!reply) {
        return [];
      }
      // Correlate in the observer namespace; TDLib IDs are not cross-account identities.
      const sameChat = (key: string, chatId: number, messageId: number) =>
        chatId === reply.chatId && key === nativeKey(reply.observer, chatId, messageId);
      // Unthreaded sends, such as a failure fallback, belong to the inbound by chat order:
      // after it and before the next inbound recorded in the same chat.
      const nextInbound = Math.min(
        ...updates.flatMap(([key, { id, update }]) => {
          const inbound = update ? undefined : nativeMessageIds.get(id);
          return inbound &&
            inbound.messageId > reply.messageId &&
            sameChat(key, inbound.chatId, inbound.messageId)
            ? [inbound.messageId]
            : [];
        }),
      );
      return updates.flatMap(([key, { update }]) =>
        update &&
        sameChat(key, update.chatId, update.messageId) &&
        (update.replyToMessageId === reply.messageId ||
          (update.replyToMessageId === undefined &&
            update.messageId > reply.messageId &&
            update.messageId < nextInbound))
          ? [structuredClone(update)]
          : [],
      );
    },
  };
}
