import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-BHVmraBM.js";
import { s as isDeliverableMessageChannel } from "./message-channel-V4touQJP.js";
//#region src/media-understanding/echo-transcript.ts
let deliverRuntimePromise = null;
function loadDeliverRuntime() {
	deliverRuntimePromise ??= import("./deliver-runtime-BK8nF47j.js");
	return deliverRuntimePromise;
}
const DEFAULT_ECHO_TRANSCRIPT_FORMAT = "📝 \"{transcript}\"";
function formatEchoTranscript(transcript, format) {
	return format.replace("{transcript}", transcript);
}
/**
* Sends the transcript echo back to the originating chat.
* Best-effort: logs on failure, never throws.
*/
async function sendTranscriptEcho(params) {
	const { ctx, cfg, transcript } = params;
	const channel = ctx.Provider ?? ctx.Surface ?? "";
	const to = ctx.OriginatingTo ?? ctx.From ?? "";
	if (!channel || !to) {
		if (shouldLogVerbose()) logVerbose("media: echo-transcript skipped (no channel/to resolved from ctx)");
		return;
	}
	const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
	if (!isDeliverableMessageChannel(normalizedChannel)) {
		if (shouldLogVerbose()) logVerbose(`media: echo-transcript skipped (channel "${normalizedChannel}" is not deliverable)`);
		return;
	}
	const text = formatEchoTranscript(transcript, params.format ?? "📝 \"{transcript}\"");
	try {
		const { deliverOutboundPayloads } = await loadDeliverRuntime();
		await deliverOutboundPayloads({
			cfg,
			channel: normalizedChannel,
			to,
			accountId: ctx.AccountId ?? void 0,
			threadId: ctx.MessageThreadId ?? void 0,
			payloads: [{ text }],
			bestEffort: true
		});
		if (shouldLogVerbose()) logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
	} catch (err) {
		logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
	}
}
//#endregion
export { sendTranscriptEcho as n, DEFAULT_ECHO_TRANSCRIPT_FORMAT as t };
