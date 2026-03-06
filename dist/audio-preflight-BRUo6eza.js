import "./run-with-concurrency-CVkEQ26G.js";
import "./paths-Cvc9EM8Y.js";
import { d as logVerbose, m as shouldLogVerbose } from "./subsystem-B9UBebHR.js";
import "./workspace-CJSTaOJf.js";
import "./logger-5RiupzZ_.js";
import "./model-selection-hBypV7rn.js";
import "./github-copilot-token-BDioPmd6.js";
import "./legacy-names-CdhkiTCG.js";
import "./thinking-BTmZIepL.js";
import "./plugins-DjZ0CVDU.js";
import "./accounts-DdJPFalP.js";
import "./accounts-CZzda7Dm.js";
import "./image-ops-DTr9Cxst.js";
import "./pi-embedded-helpers-BqdZ2WJ4.js";
import "./chrome-Dr7FDJN9.js";
import "./frontmatter-DdUAZ1DV.js";
import "./skills-C97Yv--s.js";
import "./path-alias-guards-Tm_5BzS2.js";
import "./redact-BkJnViY6.js";
import "./errors-XoYNBNa9.js";
import "./fs-safe-54mRDvhR.js";
import "./proxy-env-8K0ubHqJ.js";
import "./store-B4Adu_41.js";
import "./accounts--DUgGZBF.js";
import "./paths-C47m6bhv.js";
import "./tool-images-DR3jtxfE.js";
import "./image-ByJbTOAc.js";
import { g as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-DgL0NvDd.js";
import "./fetch-BchUD2xl.js";
import "./fetch-guard-DoTHIOVQ.js";
import "./api-key-rotation-BdB4aSfv.js";
import "./proxy-fetch-Bc_b6yL6.js";

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