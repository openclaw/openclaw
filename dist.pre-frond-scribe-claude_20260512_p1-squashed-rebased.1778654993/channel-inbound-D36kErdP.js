import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveStorePath } from "./paths-B3IZXng3.js";
import { n as readSessionUpdatedAt } from "./store-Dn6p-fz_.js";
import "./sessions-CaK_EJUM.js";
import "./mentions-Z5qZrdeH.js";
import { t as hasControlCommand } from "./command-detection-CbwOxntJ.js";
import { a as resolveEnvelopeFormatOptions } from "./envelope-ChW7_JdU.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-B_5Bfp9J.js";
import "./direct-dm-0TaJibwt.js";
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
export { createChannelInboundDebouncer as n, shouldDebounceTextInbound as r, resolveInboundSessionEnvelopeContext as t };
