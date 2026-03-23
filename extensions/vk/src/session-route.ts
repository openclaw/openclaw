import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";

const VK_GROUP_CHAT_PEER_ID_MIN = 2_000_000_000;

function parseVkPeerTarget(raw: string): { peerId: string; chatType: "direct" | "group" } | null {
  const withoutProvider = stripChannelTargetPrefix(raw, "vk");
  if (!withoutProvider) {
    return null;
  }
  const normalized = withoutProvider.trim();
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  const explicitGroup = lower.startsWith("group:") || lower.startsWith("chat:");
  const peerId = stripTargetKindPrefix(normalized);
  if (!/^\d+$/.test(peerId)) {
    return null;
  }
  return {
    peerId,
    chatType: explicitGroup || Number(peerId) >= VK_GROUP_CHAT_PEER_ID_MIN ? "group" : "direct",
  };
}

export function resolveVkOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseVkPeerTarget(params.target);
  if (!parsed) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "vk",
    accountId: params.accountId,
    peer: {
      kind: parsed.chatType,
      id: parsed.peerId,
    },
    chatType: parsed.chatType,
    from: parsed.chatType === "group" ? `vk:group:${parsed.peerId}` : `vk:${parsed.peerId}`,
    to: `vk:${parsed.peerId}`,
  });
}
