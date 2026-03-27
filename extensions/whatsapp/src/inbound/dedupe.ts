import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";

const RECENT_WEB_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_WEB_MESSAGE_MAX = 5000;
const RECENT_OUTBOUND_MESSAGE_TTL_MS = 20 * 60_000;
const RECENT_OUTBOUND_MESSAGE_MAX = 5000;

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_WEB_MESSAGE_TTL_MS,
  maxSize: RECENT_WEB_MESSAGE_MAX,
});
const recentOutboundMessages = createDedupeCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});
const recentOutboundMessageIds = createDedupeCache({
  ttlMs: RECENT_OUTBOUND_MESSAGE_TTL_MS,
  maxSize: RECENT_OUTBOUND_MESSAGE_MAX,
});

function buildMessageKey(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string | null {
  const accountId = params.accountId.trim();
  const remoteJid = params.remoteJid.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !remoteJid || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${remoteJid}:${messageId}`;
}

function buildMessageIdKey(params: { accountId: string; messageId: string }): string | null {
  const accountId = params.accountId.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !messageId || messageId === "unknown") {
    return null;
  }
  return `${accountId}:${messageId}`;
}

export function resetWebInboundDedupe(): void {
  recentInboundMessages.clear();
  recentOutboundMessages.clear();
  recentOutboundMessageIds.clear();
}

export function isRecentInboundMessage(key: string): boolean {
  return recentInboundMessages.check(key);
}

export function rememberRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildMessageKey(params);
  if (!key) {
    return;
  }
  recentOutboundMessages.check(key);
  const messageIdKey = buildMessageIdKey(params);
  if (messageIdKey) {
    recentOutboundMessageIds.check(messageIdKey);
  }
}

export function isRecentOutboundMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): boolean {
  const key = buildMessageKey(params);
  if (!key) {
    return false;
  }
  return recentOutboundMessages.peek(key);
}

export function isRecentOutboundMessageId(params: {
  accountId: string;
  messageId: string;
}): boolean {
  const key = buildMessageIdKey(params);
  if (!key) {
    return false;
  }
  return recentOutboundMessageIds.peek(key);
}
