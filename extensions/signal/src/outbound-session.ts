// Signal plugin module implements outbound session behavior.
import type { RoutePeer } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalPeerId, resolveSignalRecipient, resolveSignalSender } from "./identity.js";
import { looksLikeUuid } from "./uuid.js";

export type ResolvedSignalOutboundTarget = {
  peer: RoutePeer;
  chatType: "direct" | "group";
  from: string;
  to: string;
};

export function resolveSignalOutboundTarget(target: string): ResolvedSignalOutboundTarget | null {
  const stripped = target.replace(/^signal:/i, "").trim();
  const lowered = normalizeLowercaseStringOrEmpty(stripped);
  if (lowered.startsWith("group:")) {
    const groupId = stripped.slice("group:".length).trim();
    if (!groupId) {
      return null;
    }
    return {
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  if (lowered.startsWith("username:") || lowered.startsWith("u:")) {
    const name = stripped.slice(stripped.indexOf(":") + 1).trim();
    if (!name) {
      return null;
    }
    // A Signal username is NOT a phone number; routing it through the phone/uuid resolver would
    // E.164-digit-strip "alice.42" into "+42" and corrupt both the delivery target and the session
    // key. Keep the username grammar intact, mirroring send.ts parseTarget.
    const id = `username:${name}`;
    return {
      peer: { kind: "direct", id },
      chatType: "direct",
      from: `signal:${id}`,
      to: `signal:${id}`,
    };
  }

  const recipient = stripped.trim();
  if (!recipient) {
    return null;
  }

  const uuidCandidate = normalizeLowercaseStringOrEmpty(recipient).startsWith("uuid:")
    ? recipient.slice("uuid:".length)
    : recipient;
  const sender = resolveSignalSender({
    sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
    sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient,
  });
  const peerId = sender ? resolveSignalPeerId(sender) : recipient;
  const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
  return {
    peer: { kind: "direct", id: peerId },
    chatType: "direct",
    from: `signal:${displayRecipient}`,
    to: `signal:${displayRecipient}`,
  };
}
