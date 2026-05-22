import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveStorePath } from "./paths-BnX-evip.js";
import { n as readSessionUpdatedAt } from "./store-DjyTbZFp.js";
import "./sessions-DgIxQTHN.js";
import "./mentions-CkM1hTW0.js";
import { t as hasControlCommand } from "./command-detection-BIsSbSni.js";
import { a as resolveEnvelopeFormatOptions } from "./envelope-CbXsB8K8.js";
import { n as resolveInboundDebounceMs, t as createInboundDebouncer } from "./inbound-debounce-HY7o7clB.js";
import "./direct-dm-BCO86pkw.js";
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
