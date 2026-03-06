import "./run-with-concurrency-ZJkCGcIf.js";
import "./accounts-CrOPd8ML.js";
import "./paths-MKyEVmEb.js";
import "./github-copilot-token-D5fdS6xD.js";
import "./config-CF9NdNtk.js";
import { B as shouldLogVerbose, R as logVerbose } from "./logger-PgEXMMsU.js";
import "./thinking-BViNVYcv.js";
import "./image-ops--NfkT4P2.js";
import "./pi-embedded-helpers-YBeQQpcr.js";
import "./plugins-DwEDo8pq.js";
import "./accounts-B1LVwWKT.js";
import "./accounts-DRrJb16g.js";
import "./paths-d2-M2JHi.js";
import "./redact-B2-F5-i_.js";
import "./errors-Bz1bmKYO.js";
import "./path-alias-guards-C5Wi52EG.js";
import "./fs-safe-BIPXQdY5.js";
import "./ssrf-BBlCfZSq.js";
import "./fetch-guard-D95NDIyK.js";
import "./local-roots-BpXLW0KA.js";
import "./tool-images-DwokwnkE.js";
import { f as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-B1ZR_hju.js";
import "./skills-CJnlf_cP.js";
import "./chrome-Cwzi9RIJ.js";
import "./store-pqSNqmKp.js";
import "./image-OEgp39cz.js";
import "./api-key-rotation-DnF417Ok.js";
import "./proxy-fetch-mVJ_cL0A.js";

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