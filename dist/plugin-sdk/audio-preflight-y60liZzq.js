import "./run-with-concurrency-xRatbMJ3.js";
import "./config-CwFG3Aiu.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-D7wQiObc.js";
import "./paths-0d8fBoC4.js";
import "./accounts-B-BIsjh0.js";
import "./plugins-CNQPL_yy.js";
import "./thinking-BCso40cf.js";
import "./accounts-CzolzCZG.js";
import "./image-ops-D8eX54vX.js";
import "./pi-embedded-helpers-C9xi3WQ0.js";
import "./accounts-CcdLGAqG.js";
import "./github-copilot-token-CKKBybuX.js";
import "./paths-BE40Chxn.js";
import { i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, p as isAudioAttachment, t as runAudioTranscription } from "./audio-transcription-runner-BintXOzS.js";
import "./image-BKWT77Cw.js";
import "./chrome-tWPEla2b.js";
import "./skills-CRtFuOJX.js";
import "./path-alias-guards-DdX97sU3.js";
import "./redact-ANq-gzX9.js";
import "./errors-B3GIhEzD.js";
import "./fs-safe-CslOH3Os.js";
import "./proxy-env-DFv8X456.js";
import "./store-DYaCw7uk.js";
import "./tool-images-C_WLUyGm.js";
import "./fetch-guard-C8VlFimC.js";
import "./api-key-rotation-jSsDsdeb.js";
import "./local-roots-CnNufxoc.js";
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