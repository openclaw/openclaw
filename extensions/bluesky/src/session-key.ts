import { buildAgentSessionKey } from "openclaw/plugin-sdk/core";

const CHANNEL_ID = "bluesky";

/**
 * Build a stable session key for a Bluesky DM conversation.
 * Keyed by convoId so the same conversation always resolves to the same agent session.
 */
export function buildBlueskySessionKey(params: {
  agentId: string;
  accountId: string;
  convoId: string;
  identityLinks?: Record<string, string[]>;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: "direct", id: params.convoId },
    dmScope: "per-account-channel-peer",
    identityLinks: params.identityLinks,
  });
}
