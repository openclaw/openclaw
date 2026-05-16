import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
//#region extensions/discord/src/monitor/preflight-audio.ts
let discordPreflightAudioRuntimePromise;
function loadDiscordPreflightAudioRuntime() {
	discordPreflightAudioRuntimePromise ??= import("./preflight-audio.runtime-BAGmU6uO.js");
	return discordPreflightAudioRuntimePromise;
}
const AUDIO_ATTACHMENT_MIME_BY_EXT = new Map([
	[".aac", "audio/aac"],
	[".caf", "audio/x-caf"],
	[".flac", "audio/flac"],
	[".m4a", "audio/mp4"],
	[".mp3", "audio/mpeg"],
	[".oga", "audio/ogg"],
	[".ogg", "audio/ogg"],
	[".opus", "audio/opus"],
	[".wav", "audio/wav"]
]);
function inferAudioAttachmentMime(attachment) {
	const contentType = normalizeOptionalString(attachment.content_type);
	if (contentType?.startsWith("audio/")) return contentType;
	if (typeof attachment.duration_secs === "number" || typeof normalizeOptionalString(attachment.waveform) === "string") return "audio/ogg";
	const ext = getFileExtension(attachment.filename ?? attachment.url);
	return ext ? AUDIO_ATTACHMENT_MIME_BY_EXT.get(ext) : void 0;
}
function collectAudioAttachments(attachments) {
	if (!Array.isArray(attachments)) return [];
	return attachments.filter((att) => normalizeOptionalString(att.url) && inferAudioAttachmentMime(att));
}
async function resolveDiscordPreflightAudioMentionContext(params) {
	const audioAttachments = collectAudioAttachments(params.message.attachments);
	const hasAudioAttachment = audioAttachments.length > 0;
	const hasTypedText = Boolean(params.message.content?.trim());
	const needsPreflightTranscription = hasAudioAttachment && !hasTypedText && (params.isDirectMessage || params.shouldRequireMention && params.mentionRegexes.length > 0);
	let transcript;
	if (needsPreflightTranscription) {
		if (params.abortSignal?.aborted) return {
			hasAudioAttachment,
			hasTypedText
		};
		try {
			const { transcribeFirstAudio } = await loadDiscordPreflightAudioRuntime();
			if (params.abortSignal?.aborted) return {
				hasAudioAttachment,
				hasTypedText
			};
			const audioUrls = audioAttachments.map((att) => att.url).map((url) => normalizeOptionalString(url)).filter((url) => Boolean(url));
			if (audioUrls.length > 0) {
				transcript = await transcribeFirstAudio({
					ctx: {
						MediaUrls: audioUrls,
						MediaTypes: audioAttachments.map((att) => inferAudioAttachmentMime(att)).filter((contentType) => Boolean(contentType))
					},
					cfg: params.cfg,
					agentDir: void 0
				});
				if (params.abortSignal?.aborted) transcript = void 0;
			}
		} catch (err) {
			logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
		}
	}
	return {
		hasAudioAttachment,
		hasTypedText,
		transcript
	};
}
//#endregion
export { resolveDiscordPreflightAudioMentionContext };
