import type { WAMessage } from "@whiskeysockets/baileys";
import { jidToE164, toWhatsappJid } from "openclaw/plugin-sdk/text-runtime";
import { normalizeDeviceScopedJid } from "../identity.js";

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
  authDir?: string;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = canonicalizeRecentMessageJid(params.remoteJid, params.authDir);
  const messageId = params.messageId?.trim() || "";
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

function canonicalizeRecentMessageJid(remoteJid: string, authDir?: string): string {
  const normalizedJid = normalizeDeviceScopedJid(remoteJid)?.trim() || "";
  if (!normalizedJid) {
    return "";
  }
  const e164 = jidToE164(normalizedJid, authDir ? { authDir } : undefined);
  return e164 ? toWhatsappJid(e164) : normalizedJid;
}

function pruneRecentMessages(now: number): void {
  while (true) {
    const oldest = state.messages.entries().next().value as
      | [string, RecentMessageEntry]
      | undefined;
    if (!oldest) {
      break;
    }
    const [oldestKey, oldestEntry] = oldest;
    if (now - oldestEntry.seenAt < RECENT_WHATSAPP_MESSAGE_TTL_MS) {
      break;
    }
    state.messages.delete(oldestKey);
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
  authDir?: string;
  now?: number;
}): void {
  const key = buildMessageKey({
    accountId: params.accountId,
    remoteJid: params.remoteJid,
    messageId: params.message?.key?.id,
    authDir: params.authDir,
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
  authDir?: string;
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
