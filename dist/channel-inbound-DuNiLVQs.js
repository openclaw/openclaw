import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { n as readSessionUpdatedAt } from "./store-3qAZ3Zl6.js";
import "./sessions-BhOk6siH.js";
import "./mentions-C1aKJ5EP.js";
import { t as hasControlCommand } from "./command-detection-bZlW0Mh2.js";
import { a as resolveEnvelopeFormatOptions } from "./envelope-DNto3K3h.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-CCEcGa_J.js";
import "./direct-dm-DhLrASUF.js";
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
