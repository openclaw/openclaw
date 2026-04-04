import type { StoredMessage } from "../database/schema.js";

/**
 * Parse a raw Baileys WAMessage into a StoredMessage for persistence.
 * Returns null if the message lacks required fields (id or remoteJid).
 */
export function parseRawMessage(rawMsg: {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  messageTimestamp?: number | Long;
  message?: Record<string, unknown>;
}): StoredMessage | null {
  const msgId = rawMsg?.key?.id;
  const remoteJid = rawMsg?.key?.remoteJid;
  if (!msgId || !remoteJid) return null;

  const fromMe = rawMsg.key!.fromMe ? 1 : 0;
  const participant = rawMsg.key!.participant ?? null;
  const ts = rawMsg.messageTimestamp
    ? Number(rawMsg.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  const msg = rawMsg.message as Record<string, unknown> | undefined;
  const content = extractTextContent(msg);
  const messageType = msg
    ? (Object.keys(msg).find((k) => k !== "messageContextInfo") ?? "unknown")
    : "unknown";

  return {
    id: msgId,
    chat_jid: remoteJid,
    sender_jid: participant,
    from_me: fromMe,
    timestamp: ts,
    content,
    message_type: messageType,
    created_at: Date.now(),
  };
}

function extractTextContent(msg: Record<string, unknown> | undefined): string | null {
  if (!msg) return null;
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  const img = msg.imageMessage as Record<string, unknown> | undefined;
  const vid = msg.videoMessage as Record<string, unknown> | undefined;
  const doc = msg.documentMessage as Record<string, unknown> | undefined;
  return (
    (msg.conversation as string) ??
    (ext?.text as string) ??
    (img?.caption as string) ??
    (vid?.caption as string) ??
    (doc?.caption as string) ??
    null
  );
}

type Long = { low: number; high: number; unsigned: boolean };
