import "./run-with-concurrency-xRatbMJ3.js";
import "./config-CRz4FKeF.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-D7wQiObc.js";
import "./paths-0d8fBoC4.js";
import "./accounts-iQWyTiEu.js";
import "./plugins-CwZgecUt.js";
import "./thinking-BoczdzWi.js";
import "./accounts-jO6XV2rV.js";
import "./image-ops-B1VWuODj.js";
import "./pi-embedded-helpers-DMyZFsAj.js";
import "./accounts-v9AU8oT0.js";
import "./github-copilot-token-CKKBybuX.js";
import "./paths-BE40Chxn.js";
import { i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, p as isAudioAttachment, t as runAudioTranscription } from "./audio-transcription-runner-qHTnCKVv.js";
import "./image-BOGlGhJ6.js";
import "./chrome-P1IQrFbF.js";
import "./skills-DIehSA_V.js";
import "./path-alias-guards-DdX97sU3.js";
import "./redact-ANq-gzX9.js";
import "./errors-B3GIhEzD.js";
import "./fs-safe-CslOH3Os.js";
import "./proxy-env-Cl92ZZ5Z.js";
import "./store-BugB53gm.js";
import "./tool-images-B3pXxi1_.js";
import "./fetch-guard-BKC0sdGh.js";
import "./api-key-rotation-DEvy3-Sc.js";
import "./local-roots-DJgdju_5.js";
import "./proxy-fetch-CBTFtikU.js";

//#region src/media-understanding/audio-preflight.ts
/**
* Transcribes the first audio attachment BEFORE mention checking.
* This allows voice notes to be processed in group chats with requireMention: true.
* Returns the transcript or undefined if transcription fails or no audio is found.
*/
async function transcribeFirstAudio(params) {
	const { ctx, cfg } = params;
	const audioConfig = cfg.tools?.media?.audio;
	if (!audioConfig || audioConfig.enabled === false) return;
	const attachments = normalizeMediaAttachments(ctx);
	if (!attachments || attachments.length === 0) return;
	const firstAudio = attachments.find((att) => att && isAudioAttachment(att) && !att.alreadyTranscribed);
	if (!firstAudio) return;
	if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
	try {
		const { transcript } = await runAudioTranscription({
			ctx,
			cfg,
			attachments,
			agentDir: params.agentDir,
			providers: params.providers,
			activeModel: params.activeModel,
			localPathRoots: resolveMediaAttachmentLocalRoots({
				cfg,
				ctx
			})
		});
		if (!transcript) return;
		firstAudio.alreadyTranscribed = true;
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`);
		return transcript;
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
		return;
	}
}

//#endregion
export { transcribeFirstAudio };