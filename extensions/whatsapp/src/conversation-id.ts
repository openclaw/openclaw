import { normalizeWhatsAppTarget } from "./normalize-target.js";

/**
 * Compile-stage normalizer for WhatsApp configured-binding conversation ids.
 *
 * Mirrors the contract used by the iMessage and BlueBubbles channel
 * plugins so the gateway's configured-binding registry can compile a
 * `bindings[]` rule like:
 *
 *   { type: "route", agentId: "relay",
 *     match: { channel: "whatsapp", accountId: "+15551234567" } }
 *
 * into a stable canonical conversation id (E.164 phone number for direct
 * messages, `<id>@g.us` for groups, `<id>@newsletter` for channels).
 *
 * Returns null if the input cannot be normalized into any of those
 * shapes, which is what the binding registry uses to decide the rule
 * does not apply to this channel and skip it.
 *
 * See issue #75211 for the original report. Before this helper landed
 * the WhatsApp plugin had no `compileConfiguredBinding` /
 * `matchInboundConversation` implementation at all, which caused the
 * binding registry to silently fall back to the default agent for every
 * inbound WhatsApp message regardless of how routes were configured,
 * including in deployments where the default agent had broader tool
 * scope than the intended target agent.
 */
export function normalizeWhatsAppAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  const normalized = normalizeWhatsAppTarget(conversationId);
  return normalized ? { conversationId: normalized } : null;
}

/**
 * Inbound matcher for WhatsApp configured bindings. Both the binding's
 * compiled conversation id and the inbound conversation id go through
 * the same normalizer, so callers can compare an authored
 * `+1 (555) 123-4567` rule against an inbound `15551234567@s.whatsapp.net`
 * jid and have them collapse onto the same `+15551234567` canonical
 * form. Returns null on a normalize failure or a real mismatch; on a
 * match returns the canonical id with the same `matchPriority: 2` value
 * the iMessage and BlueBubbles plugins use.
 */
export function matchWhatsAppAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  const binding = normalizeWhatsAppAcpConversationId(params.bindingConversationId);
  const conversation = normalizeWhatsAppAcpConversationId(params.conversationId);
  if (!binding || !conversation) {
    return null;
  }
  if (binding.conversationId !== conversation.conversationId) {
    return null;
  }
  return {
    conversationId: conversation.conversationId,
    matchPriority: 2,
  };
}

/**
 * Resolves an outbound message target (or a CLI/command target) into a
 * WhatsApp conversation id, used by `bindings.resolveCommandConversation`
 * to route slash commands and similar contexts. Returns undefined when
 * the input does not look like a WhatsApp target so the binding
 * registry can fall through to the next provider.
 */
export function resolveWhatsAppConversationIdFromTarget(target: string): string | undefined {
  return normalizeWhatsAppAcpConversationId(target)?.conversationId;
}
