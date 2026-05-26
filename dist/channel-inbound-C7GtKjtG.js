import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { a as readSessionUpdatedAt } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import "./mentions-DmNrCnsQ.js";
import { r as isControlCommandMessage } from "./command-detection-CC0FOFv2.js";
import { a as resolveEnvelopeFormatOptions } from "./envelope-DUI2KFD9.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-DQpLvByk.js";
import { c as filterChannelInboundSupplementalContext, s as buildChannelInboundEventContext } from "./kernel-BXIm_f4L.js";
import "./direct-dm-CwAHI8JL.js";
//#region src/channels/inbound-debounce-policy.ts
function shouldDebounceTextInbound(params) {
	if (params.allowDebounce === false) return false;
	if (params.hasMedia) return false;
	const text = normalizeOptionalString(params.text) ?? "";
	if (!text) return false;
	return !isControlCommandMessage(text, params.cfg, params.commandOptions);
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
