import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { s as isDeliverableMessageChannel } from "./message-channel-CYCKkVrh.js";
//#region src/media-understanding/echo-transcript.ts
let messageRuntimePromise = null;
function loadMessageRuntime() {
	messageRuntimePromise ??= import("./runtime-DpGOQShF.js");
	return messageRuntimePromise;
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
		const { sendDurableMessageBatch } = await loadMessageRuntime();
		const send = await sendDurableMessageBatch({
			cfg,
			channel: normalizedChannel,
			to,
			accountId: ctx.AccountId ?? void 0,
			threadId: ctx.MessageThreadId ?? void 0,
			payloads: [{ text }],
			bestEffort: true,
			durability: "best_effort"
		});
		if (send.status === "failed") throw send.error;
		if (shouldLogVerbose()) logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
	} catch (err) {
		logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
	}
}
//#endregion
export { sendTranscriptEcho as n, DEFAULT_ECHO_TRANSCRIPT_FORMAT as t };
