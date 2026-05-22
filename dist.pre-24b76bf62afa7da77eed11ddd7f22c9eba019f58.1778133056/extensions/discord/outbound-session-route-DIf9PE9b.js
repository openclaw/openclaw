import { t as buildOutboundBaseSessionKey } from "../../base-session-key-g_kR2Eva.js";
import { n as buildThreadAwareOutboundSessionRoute } from "../../core-BsEhQ_g7.js";
import "../../channel-core-BASvgwzh.js";
import "../../routing-MIJf671J.js";
import { o as parseDiscordTarget } from "./normalize--W8rXVCt.js";
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
