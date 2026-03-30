import {
	buildChannelOutboundSessionRoute,
	type ChannelOutboundSessionRouteParams,
	stripChannelTargetPrefix,
	stripTargetKindPrefix,
} from "openclaw/plugin-sdk/core";

export function resolveZaloOutboundSessionRoute(
	params: ChannelOutboundSessionRouteParams,
) {
	const trimmed = stripChannelTargetPrefix(params.target, "zalo", "zl");
	if (!trimmed) {
		return null;
	}
	const isGroup = trimmed.toLowerCase().startsWith("group:");
	const peerId = stripTargetKindPrefix(trimmed);
	if (!peerId) {
		return null;
	}
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "zalo",
		accountId: params.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: peerId,
		},
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `zalo:group:${peerId}` : `zalo:${peerId}`,
		to: `zalo:${peerId}`,
	});
}
