import {
  compileDirectPeerConversation,
  isDirectPeerBinding,
  matchDirectPeerConversation,
} from "openclaw/plugin-sdk/direct-peer-binding";
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
  return isDirectPeerBinding(peerKind);
}

/**
 * Canonicalizes a Telegram direct-peer id (bare positive id or `direct:<id>`)
 * for the channel-agnostic direct-peer binding helpers.
 */
function normalizeTelegramDirectPeerId(id: string): string | null {
  return parseTelegramDirectConversation({ conversationId: id })?.canonicalConversationId ?? null;
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
    return compileDirectPeerConversation({
      conversationId: params.conversationId,
      normalizePeerId: normalizeTelegramDirectPeerId,
    });
  }
  return normalizeTelegramAcpTopicConversationId(params.conversationId);
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
    return matchDirectPeerConversation({
      bindingConversationId: params.bindingConversationId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
      normalizePeerId: normalizeTelegramDirectPeerId,
    });
  }
  return matchTelegramAcpTopicConversation(params);
}
