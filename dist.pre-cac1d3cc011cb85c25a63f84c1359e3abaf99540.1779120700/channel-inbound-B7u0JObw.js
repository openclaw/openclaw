import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./agent-scope-EKUvJ3MC.js";
import { r as resolveAgentConfig } from "./agent-scope-config-BdqZvTnb.js";
import { u as resolveStorePath } from "./paths-_BPRx1WO.js";
import { n as readSessionUpdatedAt } from "./store-B2ygcrQO.js";
import "./sessions-DLuO5EGG.js";
import "./mentions-Qf2VJIjv.js";
import { t as hasControlCommand } from "./command-detection-D31DbWtT.js";
import { a as resolveEnvelopeFormatOptions } from "./envelope-DP4ERcPB.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-ClTOMGii.js";
import { c as filterChannelInboundSupplementalContext, s as buildChannelInboundEventContext } from "./kernel-Cn_n4ofP.js";
import "./direct-dm-D3WyRFKA.js";
//#region src/channels/inbound-debounce-policy.ts
function shouldDebounceTextInbound(params) {
	if (params.allowDebounce === false) return false;
	if (params.hasMedia) return false;
	const text = normalizeOptionalString(params.text) ?? "";
	if (!text) return false;
	return !hasControlCommand(text, params.cfg, params.commandOptions);
}
function createChannelInboundDebouncer(params) {
	const debounceMs = resolveInboundDebounceMs({
		cfg: params.cfg,
		channel: params.channel,
		overrideMs: params.debounceMsOverride
	});
	const { cfg: _cfg, channel: _channel, debounceMsOverride: _override, ...rest } = params;
	return {
		debounceMs,
		debouncer: createInboundDebouncer({
			debounceMs,
			...rest
		})
	};
}
//#endregion
//#region src/channels/session-envelope.ts
function resolveInboundSessionEnvelopeContext(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
	return {
		storePath,
		envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
		previousTimestamp: readSessionUpdatedAt({
			storePath,
			sessionKey: params.sessionKey
		})
	};
}
//#endregion
//#region src/channels/inbound-event/classification.ts
function classifyChannelInboundEvent(params) {
	if (params.unmentionedGroupPolicy !== "room_event") return "user_request";
	if (params.conversation.kind !== "group" && params.conversation.kind !== "channel") return "user_request";
	if (params.wasMentioned === true || params.hasControlCommand === true || params.hasAbortRequest === true || params.commandSource === "native") return "user_request";
	return "room_event";
}
function resolveUnmentionedGroupInboundPolicy(params) {
	const agentGroupChat = params.agentId ? resolveAgentConfig(params.cfg, params.agentId)?.groupChat : void 0;
	if (agentGroupChat && Object.hasOwn(agentGroupChat, "unmentionedInbound")) return agentGroupChat.unmentionedInbound ?? "user_request";
	return params.cfg.messages?.groupChat?.unmentionedInbound ?? "user_request";
}
//#endregion
//#region src/plugin-sdk/channel-inbound.ts
function buildChannelTurnContext(params) {
	const inboundEventKind = params.message.inboundEventKind ?? params.message.inboundTurnKind;
	const ctx = buildChannelInboundEventContext({
		...params,
		message: {
			...params.message,
			...inboundEventKind ? { inboundEventKind } : {}
		}
	});
	return {
		...ctx,
		InboundTurnKind: ctx.InboundEventKind
	};
}
const filterChannelTurnSupplementalContext = filterChannelInboundSupplementalContext;
//#endregion
export { resolveInboundSessionEnvelopeContext as a, resolveUnmentionedGroupInboundPolicy as i, filterChannelTurnSupplementalContext as n, createChannelInboundDebouncer as o, classifyChannelInboundEvent as r, shouldDebounceTextInbound as s, buildChannelTurnContext as t };
