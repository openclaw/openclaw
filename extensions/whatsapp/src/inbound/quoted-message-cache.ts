import type { WAMessage } from "@whiskeysockets/baileys";

const DEFAULT_QUOTED_MESSAGE_CACHE_LIMIT = 512;
const DEFAULT_QUOTED_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CachedQuotedMessage = {
  message: WAMessage;
  storedAt: number;
};

export function normalizeQuotedMessage(params: {
  message: WAMessage;
  messageId?: string;
  remoteJid?: string;
  participantJid?: string;
  isGroup?: boolean;
}): WAMessage | undefined {
  const messageId = params.messageId?.trim() || params.message.key?.id?.trim();
  const remoteJid = params.remoteJid?.trim() || params.message.key?.remoteJid?.trim();
  if (!messageId || !remoteJid || !params.message.message) {
    return undefined;
  }

  const participant = params.isGroup
    ? params.participantJid?.trim() || params.message.key?.participant?.trim() || undefined
    : undefined;
  const { participant: _ignoredParticipant, ...restKey } = params.message.key ?? {};

  return {
    ...params.message,
    key: {
      // Keep the original key metadata from the inbound message so we do not
      // throw away Baileys addressing hints such as remoteJidAlt/participantAlt.
      ...restKey,
      id: messageId,
      remoteJid,
      fromMe: false,
      ...(participant ? { participant } : {}),
    },
  };
}

function alignQuotedMessageToJid(message: WAMessage, jid: string): WAMessage {
  const cachedRemoteJid = message.key.remoteJid?.trim();
  if (!cachedRemoteJid || cachedRemoteJid === jid || cachedRemoteJid.endsWith("@g.us")) {
    return message;
  }
  return {
    ...message,
    key: {
      ...message.key,
      // Baileys compares the outbound jid against quoted.key.remoteJid when
      // building contextInfo, so direct-chat quotes should follow the actual
      // send target while retaining the original inbound identifier for future
      // reconciliation.
      remoteJid: jid,
      remoteJidAlt: cachedRemoteJid,
    },
  };
}

export function createQuotedMessageCache(options?: { limit?: number; ttlMs?: number }) {
  const cache = new Map<string, CachedQuotedMessage>();
  const limit = options?.limit ?? DEFAULT_QUOTED_MESSAGE_CACHE_LIMIT;
  const ttlMs = options?.ttlMs ?? DEFAULT_QUOTED_MESSAGE_CACHE_TTL_MS;

  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now - entry.storedAt > ttlMs) {
        cache.delete(key);
      }
    }
    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  const remember = (params: {
    message: WAMessage;
    remoteJid?: string;
    normalizedJid?: string;
    messageId?: string;
    participantJid?: string;
    isGroup?: boolean;
  }) => {
    const normalizedMessage = normalizeQuotedMessage({
      message: params.message,
      messageId: params.messageId,
      remoteJid: params.remoteJid,
      participantJid: params.participantJid,
      isGroup: params.isGroup,
    });
    const messageId = normalizedMessage?.key?.id?.trim();
    if (!normalizedMessage || !messageId) {
      return;
    }
    const storedAt = Date.now();
    // Index by both the stored inbound JID and the normalized outbound JID so
    // direct-chat replies can resolve the same message from either shape.
    const candidateJids = [params.remoteJid, params.normalizedJid]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    for (const jid of candidateJids) {
      cache.set(`${jid}:${messageId}`, {
        message: normalizedMessage,
        storedAt,
      });
    }
    prune();
  };

  const resolve = (params: { jid: string; replyToId: string }): WAMessage | undefined => {
    prune();
    const message = cache.get(`${params.jid}:${params.replyToId}`)?.message;
    return message ? alignQuotedMessageToJid(message, params.jid) : undefined;
  };

  return {
    remember,
    resolve,
  };
}
