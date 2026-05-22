import { t as buildOutboundBaseSessionKey } from "../../base-session-key-D_CGjCaV.js";
import { n as buildThreadAwareOutboundSessionRoute } from "../../core-B2c9_N7p.js";
import "../../channel-core-B5hKA5Gy.js";
import "../../routing-DfF4_bqH.js";
import { c as parseDiscordTarget } from "./target-resolver-YAvCjRtK.js";
//#region extensions/discord/src/outbound-session-route.ts
function resolveDiscordOutboundSessionRoute(params) {
	const parsed = parseDiscordTarget(params.target, { defaultKind: resolveDiscordOutboundTargetKindHint(params) });
	if (!parsed) return null;
	const isDm = parsed.kind === "user";
	const peer = {
		kind: isDm ? "direct" : "channel",
		id: parsed.id
	};
	const baseSessionKey = buildOutboundBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "discord",
		accountId: params.accountId,
		peer
	});
	return buildThreadAwareOutboundSessionRoute({
		route: {
			sessionKey: baseSessionKey,
			baseSessionKey,
			peer,
			chatType: isDm ? "direct" : "channel",
			from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
			to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`
		},
		threadId: params.threadId,
		precedence: ["threadId"],
		useSuffix: false
	});
}
function resolveDiscordOutboundTargetKindHint(params) {
	const resolvedKind = params.resolvedTarget?.kind;
	if (resolvedKind === "user") return "user";
	if (resolvedKind === "group" || resolvedKind === "channel") return "channel";
	const target = params.target.trim();
	if (/^channel:/i.test(target)) return "channel";
	if (/^(user:|discord:|@|<@!?)/i.test(target)) return "user";
}
//#endregion
export { resolveDiscordOutboundSessionRoute as t };
