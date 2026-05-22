import { t as buildOutboundBaseSessionKey } from "./base-session-key-CSHF6qeo.js";
import { n as buildThreadAwareOutboundSessionRoute } from "./core-C8nU4cB6.js";
import "./channel-core-B_vg0lpe.js";
import "./routing-CvMyJlKL.js";
import { o as parseDiscordTarget } from "./normalize-CXn44Q3y.js";
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
