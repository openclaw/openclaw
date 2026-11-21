import {
  isRecord,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Telegram replies name a provider message_id. Inbound bus IDs already are one; a bot send's
 * bus ID maps to the `messageId` Crabline records on the accepted send's API event.
 */
export function createCrablineTelegramReplies() {
  const messageIdByBusId = new Map<string, string>();
  return {
    observeSend(event: unknown, busMessageId: string) {
      const messageId = isRecord(event)
        ? normalizeStringifiedOptionalString(event.messageId)
        : undefined;
      if (messageId) {
        messageIdByBusId.set(busMessageId, messageId);
      }
    },
    resolve(replyToId: string) {
      const messageId =
        messageIdByBusId.get(replyToId) ?? (/^\d+$/u.test(replyToId) ? replyToId : undefined);
      if (!messageId) {
        throw new Error(`Telegram QA reply target ${replyToId} has no Crabline message_id.`);
      }
      return messageId;
    },
    reset() {
      messageIdByBusId.clear();
    },
  };
}
