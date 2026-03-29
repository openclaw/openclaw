import type { WAMessage } from "@whiskeysockets/baileys";

const RECENT_WHATSAPP_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WHATSAPP_MESSAGE_MAX = 5000;
const RECENT_WHATSAPP_MESSAGE_STATE_KEY = Symbol.for("openclaw.whatsapp.recentMessageState");

type RecentMessageEntry = {
  message: WAMessage;
  seenAt: number;
};

type RecentMessageState = {
  messages: Map<string, RecentMessageEntry>;
};

const g = globalThis as unknown as Record<symbol, RecentMessageState | undefined>;
if (!g[RECENT_WHATSAPP_MESSAGE_STATE_KEY]) {
  g[RECENT_WHATSAPP_MESSAGE_STATE_KEY] = {
    messages: new Map<string, RecentMessageEntry>(),
  };
}
const state = g[RECENT_WHATSAPP_MESSAGE_STATE_KEY]!;

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string | null | undefined;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId?.trim() || "";
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

function pruneRecentMessages(now: number): void {
  const cutoff = now - RECENT_WHATSAPP_MESSAGE_TTL_MS;
  for (const [key, entry] of state.messages) {
    if (entry.seenAt < cutoff) {
      state.messages.delete(key);
    }
  }
  while (state.messages.size > RECENT_WHATSAPP_MESSAGE_MAX) {
    const oldestKey = state.messages.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.messages.delete(oldestKey);
  }
}

export function rememberRecentWhatsAppMessage(params: {
  accountId: string;
  remoteJid: string;
  message: WAMessage | null | undefined;
  now?: number;
}): void {
  const key = buildMessageKey({
    accountId: params.accountId,
    remoteJid: params.remoteJid,
    messageId: params.message?.key?.id,
  });
  if (!key || !params.message?.message) {
    return;
  }
  const seenAt = params.now ?? Date.now();
  const message = {
    ...params.message,
    key: {
      ...params.message.key,
      remoteJid: params.message.key?.remoteJid ?? params.remoteJid,
    },
  } satisfies WAMessage;
  state.messages.delete(key);
  state.messages.set(key, { message, seenAt });
  pruneRecentMessages(seenAt);
}

export function getRecentWhatsAppMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  now?: number;
}): WAMessage | null {
  const key = buildMessageKey(params);
  if (!key) {
    return null;
  }
  const entry = state.messages.get(key);
  if (!entry) {
    return null;
  }
  const now = params.now ?? Date.now();
  if (now - entry.seenAt >= RECENT_WHATSAPP_MESSAGE_TTL_MS) {
    state.messages.delete(key);
    return null;
  }
  return entry.message;
}

export function resetRecentWhatsAppMessages(): void {
  state.messages.clear();
}
