import "./run-with-concurrency-CjtfZs6b.js";
import "./paths-CaA28K0s.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-LCySwiUR.js";
import "./model-selection-BqtUN-ve.js";
import "./github-copilot-token-BWXANsA6.js";
import "./thinking-BYVteSNG.js";
import "./plugins-Db8HMxFM.js";
import "./accounts-D8uJMILd.js";
import "./accounts-ABnMfU-g.js";
import "./image-ops-DowHMQTO.js";
import "./pi-embedded-helpers-fp__I_vf.js";
import "./chrome-CHpRi9C8.js";
import "./skills-DV8ZoUj0.js";
import "./path-alias-guards-BF_HXkDo.js";
import "./redact-D2fhu2bA.js";
import "./errors-f2HfHmuq.js";
import "./fs-safe-DzDyYmaN.js";
import "./proxy-env-DZJ-zNvv.js";
import "./store-rWQguO-N.js";
import "./accounts-BWgbWs8e.js";
import "./paths-D8NIBFju.js";
import "./tool-images-C74tnzzo.js";
import "./image-glVS0hb2.js";
import { g as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-JWIP8xXu.js";
import "./fetch-Cx3L9iaW.js";
import "./fetch-guard-DImDoh4t.js";
import "./api-key-rotation-CoaWZuEj.js";
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