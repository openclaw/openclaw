import type { RoutePeer } from "openclaw/plugin-sdk/routing";
import { resolveSignalPeerId, resolveSignalRecipient, resolveSignalSender } from "./identity.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { looksLikeUuid } from "./uuid.js";

export type ResolvedSignalOutboundTarget = {
  peer: RoutePeer;
  chatType: "direct" | "group";
  from: string;
  to: string;
};

export function resolveSignalOutboundTarget(target: string): ResolvedSignalOutboundTarget | null {
  const normalized = normalizeSignalMessagingTarget(target);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("group:")) {
    const groupId = normalized.slice("group:".length);
    return {
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  const recipient = normalized;
  // Username targets already own their direct-chat identity; phone coercion would digit-strip them.
  const sender = recipient.startsWith("username:")
    ? null
    : resolveSignalSender(
        looksLikeUuid(recipient) ? { sourceUuid: recipient } : { sourceNumber: recipient },
      );
  const peerId = sender ? resolveSignalPeerId(sender) : recipient;
  const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
  return {
    peer: { kind: "direct", id: peerId },
    chatType: "direct",
    from: `signal:${displayRecipient}`,
    to: `signal:${displayRecipient}`,
  };
}
