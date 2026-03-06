import "./paths-BBP4yd-2.js";
import { o as logVerbose, u as shouldLogVerbose } from "./globals-DBA9iEt5.js";
import "./utils-BgHhhQlR.js";
import "./thinking-44rmAw5o.js";
import "./agent-scope-DcOd8osz.js";
import "./subsystem-B6NrUFrh.js";
import "./openclaw-root-rLmdSaR4.js";
import "./logger-JY9zcN88.js";
import "./exec-DOBmQ145.js";
import "./model-selection-COYmqEoi.js";
import "./registry-DBb6KIXY.js";
import "./github-copilot-token-D9l3eOWF.js";
import "./boolean-C6Pbt2Ue.js";
import "./env-BfNMiMlQ.js";
import "./manifest-registry-BS8o_I_L.js";
import "./runtime-overrides-COUAbg1N.js";
import "./dock-D67Q8hqq.js";
import "./message-channel-BTTrmWeS.js";
import "./plugins-CVNXMV8f.js";
import "./sessions-DICryTKD.js";
import { d as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-GMqQalEp.js";
import "./image-D86azZkZ.js";
import "./models-config-D6yWFKHl.js";
import "./pi-embedded-helpers-4c583e5O.js";
import "./sandbox-B99_qo5_.js";
import "./tool-catalog-IBWCA-2a.js";
import "./chrome-BHZCnUQK.js";
import "./tailscale-CuFyx_x9.js";
import "./tailnet-ZGehJquv.js";
import "./ws-C0C8fn9j.js";
import "./auth-_bAG6RXt.js";
import "./server-context-BAtMECx_.js";
import "./frontmatter-DobVhJLD.js";
import "./skills-DOWW7Nlf.js";
import "./path-alias-guards-DHN0MYP9.js";
import "./paths-L5nChQ8H.js";
import "./redact-BIlIgsBb.js";
import "./errors-DRE3vN3Q.js";
import "./fs-safe-CAprtaTc.js";
import "./proxy-env-B4mNR5H5.js";
import "./image-ops-_Momh5Q_.js";
import "./store-B8nZst-N.js";
import "./ports-dE92jbnn.js";
import "./trash-CJfp7H-I.js";
import "./server-middleware-DaRy-OMg.js";
import "./accounts-DXxZARtQ.js";
import "./accounts-Z1bz-0gv.js";
import "./logging-CZCkEw2g.js";
import "./accounts-RlQcOaUI.js";
import "./paths-J0EFKbLQ.js";
import "./chat-envelope-BZKQmhVe.js";
import "./tool-images-CxRDpS1l.js";
import "./tool-display-oPtLgvHX.js";
import "./fetch-guard-DNVP4AD6.js";
import "./api-key-rotation-fBrWbbU-.js";
import "./local-roots-BGOsLcJv.js";
import "./model-catalog-Asyj36Mm.js";
import "./proxy-fetch-D-ERJUt-.js";

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