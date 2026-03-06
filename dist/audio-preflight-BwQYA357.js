import "./run-with-concurrency-CjtfZs6b.js";
import "./paths-CaA28K0s.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-LCySwiUR.js";
import "./model-selection-BWORP6Gv.js";
import "./github-copilot-token-BWXANsA6.js";
import "./thinking-B_ujPq7h.js";
import "./plugins-DixHz2Uh.js";
import "./accounts-CoCwikG7.js";
import "./accounts-CVwX9650.js";
import "./image-ops-BA3ju5Yg.js";
import "./pi-embedded-helpers-V_SP4T4r.js";
import "./chrome-D71BypSw.js";
import "./skills-Risg_IkA.js";
import "./path-alias-guards-BF_HXkDo.js";
import "./redact-D2fhu2bA.js";
import "./errors-f2HfHmuq.js";
import "./fs-safe-DzDyYmaN.js";
import "./proxy-env-DVcTD5uq.js";
import "./store-Bjg5WMyN.js";
import "./accounts-CdQRN-cd.js";
import "./paths-D8NIBFju.js";
import "./tool-images-CLC_3p0e.js";
import "./image-1B3RQnPY.js";
import { g as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-EZOhq6xe.js";
import "./fetch-hyBJDZgj.js";
import "./fetch-guard-DW8T9k9b.js";
import "./api-key-rotation-Cr8h53hT.js";
import "./proxy-fetch-CwTNGRWJ.js";

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