import "./run-with-concurrency-CtAWceEI.js";
import "./paths-C6TxBCvO.js";
import { d as logVerbose, m as shouldLogVerbose } from "./subsystem-BRgnv2j0.js";
import "./workspace-buUezKOj.js";
import "./logger-2lihXGmH.js";
import "./model-selection-D-zc9Jb3.js";
import "./github-copilot-token-D13V9YBz.js";
import "./legacy-names-UtW-25Fu.js";
import "./thinking-B9zygAE1.js";
import "./plugins-DtC13lY-.js";
import "./accounts-Dnv03KpM.js";
import "./accounts-B-E364-r.js";
import "./image-ops-Dz6A36dh.js";
import "./pi-embedded-helpers-DGdW7_Fe.js";
import "./chrome-e90mQRbq.js";
import "./frontmatter-B1YIuX78.js";
import "./skills-CuGToNMJ.js";
import "./path-alias-guards-nJ8fVkuc.js";
import "./redact-DYOZyabt.js";
import "./errors-DBMuZkJB.js";
import "./fs-safe-BPM-Flk7.js";
import "./proxy-env-CSux5Cdw.js";
import "./store-CI07lZq8.js";
import "./accounts-BL5AKl_m.js";
import "./paths-CJ8i-g5g.js";
import "./tool-images-CSCGkO_H.js";
import "./image-Bb5_JgpF.js";
import { g as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-BoGCvMW5.js";
import "./fetch-CEjS-VCv.js";
import "./fetch-guard-Chzxbsnj.js";
import "./api-key-rotation-B68-9R33.js";
import "./proxy-fetch-DYLFpQUa.js";

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