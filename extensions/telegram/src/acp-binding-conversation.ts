import { parseTelegramDirectConversation } from "./direct-conversation.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

export type TelegramAcpConversationRef = {
  conversationId: string;
  parentConversationId?: string;
};

export type TelegramAcpConversationMatch = TelegramAcpConversationRef & {
  matchPriority: number;
};

/**
 * Returns true when a configured binding explicitly targets a direct (1:1)
 * peer. The generic binding schema permits `direct` and the legacy `dm` alias;
 * everything else (group/channel/unset) keeps the existing topic behavior.
 */
export function isTelegramDirectPeerBinding(peerKind?: string): boolean {
  const normalized = peerKind?.trim().toLowerCase();
  return normalized === "direct" || normalized === "dm";
}

function normalizeTelegramAcpTopicConversationId(
  conversationId: string,
): TelegramAcpConversationRef | null {
  const parsed = parseTelegramTopicConversation({ conversationId });
  if (!parsed || !parsed.chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: parsed.chatId,
  };
}

function normalizeTelegramAcpDirectConversationId(
  conversationId: string,
): TelegramAcpConversationRef | null {
  const parsed = parseTelegramDirectConversation({ conversationId });
  if (!parsed) {
    return null;
  }
  // DMs have no parent conversation; the canonical id is the bare peer id, which
  // is exactly the inbound conversation id the route uses for a 1:1 chat.
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: undefined,
  };
}

/**
 * Compiles a configured ACP binding into a Telegram conversation ref.
 *
 * Direct-peer bindings (opt-in via `match.peer.kind: "direct"`/`"dm"`) compile
 * to the bare positive peer id; everything else keeps the legacy topic shape.
 * Returns null when the configured id does not match the requested peer kind.
 */
export function compileTelegramAcpConversation(params: {
  peerKind?: string;
  conversationId: string;
}): TelegramAcpConversationRef | null {
  if (isTelegramDirectPeerBinding(params.peerKind)) {
    return normalizeTelegramAcpDirectConversationId(params.conversationId);
  }
  return normalizeTelegramAcpTopicConversationId(params.conversationId);
}

function matchTelegramAcpDirectConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}): TelegramAcpConversationMatch | null {
  const binding = normalizeTelegramAcpDirectConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  // Inbound DMs carry the bare positive peer id with no parent conversation. A
  // group/topic inbound (negative chat id or a topic id with a parent) must not
  // match a direct binding.
  if (params.parentConversationId?.trim()) {
    return null;
  }
  const incoming = parseTelegramDirectConversation({
    conversationId: params.conversationId,
  });
  if (!incoming) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    parentConversationId: undefined,
    matchPriority: 2,
  };
}

function matchTelegramAcpTopicConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}): TelegramAcpConversationMatch | null {
  const binding = normalizeTelegramAcpTopicConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!incoming || !incoming.chatId.startsWith("-")) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    parentConversationId: incoming.chatId,
    matchPriority: 2,
  };
}

/**
 * Matches an inbound Telegram conversation against a compiled ACP binding.
 *
 * Direct-peer bindings match a bare positive peer id with no parent (the inbound
 * DM shape); all other bindings keep the legacy group/topic matching.
 */
export function matchTelegramAcpConversation(params: {
  peerKind?: string;
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}): TelegramAcpConversationMatch | null {
  if (isTelegramDirectPeerBinding(params.peerKind)) {
    return matchTelegramAcpDirectConversation(params);
  }
  return matchTelegramAcpTopicConversation(params);
}
