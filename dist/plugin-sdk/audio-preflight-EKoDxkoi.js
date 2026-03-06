import "./run-with-concurrency-DHFRtnak.js";
import "./accounts-Cy2gQPFU.js";
import "./paths-MKyEVmEb.js";
import "./github-copilot-token-D5fdS6xD.js";
import "./config-CLyNhGJB.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-Dv6Sz3FH.js";
import "./thinking-CZvBic9o.js";
import "./image-ops-BtAdsAjC.js";
import "./pi-embedded-helpers-D4lmdUye.js";
import "./plugins-C0IHUoNk.js";
import "./accounts-D1isUmNz.js";
import "./accounts-j7Ehc-7D.js";
import "./paths-BYsZgUsy.js";
import "./redact-NS3jMXUa.js";
import "./errors-mEzH8r2i.js";
import "./path-alias-guards-B_fvYSKr.js";
import "./fs-safe-D2iDsCwG.js";
import "./ssrf-DjzBPLie.js";
import "./fetch-guard-DuOhO7_M.js";
import "./local-roots-BuHIaC7X.js";
import "./tool-images-DfN6N269.js";
import { f as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-4MGwfugr.js";
import "./skills-BMPKzQ-L.js";
import "./chrome-mEjk2jqL.js";
import "./store-B53CUPMo.js";
import "./image-CnWA4cI4.js";
import "./api-key-rotation-CC_DLaRW.js";
import "./proxy-fetch-BWV7Qea4.js";

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