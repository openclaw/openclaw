// Per-inbound session-key derivation, mirroring openclaw's canonical
// scheme (src/config/sessions/session-key.ts) so the conversations table
// the control plane upserts is keyed identically to the agent runtime's
// own session bucket.
//
// Canonical shapes:
//   agent:main:main                       — owner DM converged across channels
//   agent:main:<channel>:group:<groupId>  — group / channel
//
// Slice B does NOT distinguish owner-DM from contact-DM at the
// session-key level (matches openclaw — the differentiation lives in
// the envelope.sender_role written to envelope-summary.json). All
// non-group direct chats collapse into agent:main:main.

export type DerivedSessionKey = {
  sessionKey: string;
  groupKey?: string;
};

export function deriveSessionKeyForInbound(
  channel: string,
  conversationId: string | undefined,
): DerivedSessionKey {
  if (isGroupConversationId(channel, conversationId)) {
    return {
      sessionKey: `agent:main:${channel}:group:${conversationId}`,
      groupKey: conversationId,
    };
  }
  // Canonical owner-DM bucket. Non-owner DMs end up here too, but the
  // envelope's sender_role tells the agent + scope filter who is talking.
  return { sessionKey: "agent:main:main" };
}

// Per-channel "is this a group conversation?" heuristic. Channels can
// disambiguate via different signals — the safe default for unknown
// shapes is treat-as-DM, since the worst case is a missed group upsert
// (still gets classification + envelope; just no group row in
// conversations table). Phase 2 plumbs proper isGroup from
// inbound_claim's richer event context.
export function isGroupConversationId(
  channel: string,
  conversationId: string | undefined,
): conversationId is string {
  if (!conversationId) {
    return false;
  }
  switch (channel) {
    case "whatsapp":
      // WhatsApp JIDs: groups end in @g.us, DMs end in @s.whatsapp.net /
      // @c.us.
      return conversationId.endsWith("@g.us");
    case "telegram":
      // Telegram chat IDs are negative for groups/supergroups, positive
      // for DMs. Also cover the "-100..." supergroup form.
      return conversationId.startsWith("-");
    case "slack":
      // Slack channel IDs are prefixed: D=DM, G=private group (legacy),
      // C=public channel, MPDM=multi-party DM.
      return /^[CG]/u.test(conversationId) || conversationId.startsWith("MPDM");
    case "discord":
    case "matrix":
    case "imessage":
    case "icloud":
    case "signal":
    case "webchat":
      // We don't get a reliable group/dm signal from message_received
      // ctx alone for these channels. Be conservative: treat as DM.
      // Phase 2 will swap this for inbound_claim's isGroup.
      return false;
    default:
      return false;
  }
}
