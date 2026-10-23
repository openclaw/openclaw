import type { WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createWhatsAppInboundMessageNormalizer } from "./message-normalization.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import type { WebListenerCloseReason } from "./types.js";

export function normalizeTestWhatsAppMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  from?: string;
  selfE164?: string | null;
  senderE164?: string | null;
  senderJid?: string | null;
  group?: boolean;
  pushName?: string;
  isFromMe?: boolean;
  messageTimestampMs?: number;
  connectedAtMs?: number;
  remoteJid?: string;
  sendMessage?: (jid: string, content: { text: string }) => Promise<unknown>;
}) {
  const from = params.from ?? "+15550001111";
  const senderE164 = params.senderE164 === undefined ? "+15550001111" : params.senderE164;
  const participant = params.senderJid ?? `${senderE164?.slice(1) ?? "unresolved"}@s.whatsapp.net`;
  const sendTrackedMessage: WhatsAppAttachedSocketSession["sendTrackedMessage"] = async (
    jid,
    content,
  ) => {
    if ("text" in content) {
      await params.sendMessage?.(jid, { text: content.text });
    }
    return undefined;
  };
  const socketSession: WhatsAppAttachedSocketSession = {
    connectedAtMs: params.connectedAtMs ?? 0,
    self: { e164: params.selfE164 === undefined ? "+15550009999" : params.selfE164 },
    onClose: new Promise<WebListenerCloseReason>(() => {}),
    signalClose: () => {},
    start: () => {},
    stop: () => {},
    closeSocket: () => {},
    listen: () => () => {},
    getCurrentSock: () => null,
    resolveInboundJid: async () => (params.group ? (senderE164 ?? null) : from),
    resolveReactionTargetJids: async (jid) => [jid],
    rememberBaileysMessage: () => {},
    assertCanSendToJid: async () => {},
    assertSendReady: async () => {},
    sendTrackedMessage,
    socketOperations: { sendMessage: sendTrackedMessage, sendPresenceUpdate: async () => {} },
    markRead: async () => {},
  };
  const normalizer = createWhatsAppInboundMessageNormalizer({
    cfg: params.cfg,
    accountId: params.accountId ?? "default",
    verbose: false,
    socketSession,
    groupMetadata: {
      start: () => {},
      close: () => {},
      get: async () => ({ expires: 0 }),
      resolveOutboundMentions: async (_jid, text) => ({ text, mentionedJids: [] }),
      applyOutboundMentions: async (_jid, content) => content,
    },
    parseTimestampSeconds: (value) => (typeof value === "number" ? value : undefined),
  });
  const message: WAMessage = {
    key: {
      id: "inbound-access-fixture",
      remoteJid:
        params.remoteJid ?? (params.group ? from : `${from.replace(/^\+/, "")}@s.whatsapp.net`),
      fromMe: params.isFromMe ?? false,
      ...(params.group ? { participant } : {}),
    },
    message: { conversation: "hello" },
    pushName: params.pushName ?? "Sam",
    ...(params.messageTimestampMs !== undefined
      ? { messageTimestamp: params.messageTimestampMs / 1000 }
      : {}),
  };
  return normalizer.normalize(message);
}
