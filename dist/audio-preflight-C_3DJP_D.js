import { o as logVerbose, u as shouldLogVerbose } from "./globals-DqM7Q4km.js";
import "./paths-BMo6kTge.js";
import "./subsystem-BXiL6bA6.js";
import "./boolean-DtWR5bt3.js";
import "./auth-profiles-C39jSzPb.js";
import "./agent-scope-BXg6mLAy.js";
import "./utils-xLjEf_5u.js";
import "./openclaw-root-CUjRHZhy.js";
import "./logger-hujp-3PD.js";
import "./exec-BpP6Q4EB.js";
import "./registry-DTmGzx3d.js";
import "./github-copilot-token-CvN6iidT.js";
import "./manifest-registry-YpcF6BWJ.js";
import "./version-cke7D5Ak.js";
import "./runtime-overrides-ChuaKEss.js";
import "./dock-CK-Sk5ak.js";
import "./frontmatter-D2o8_Jfu.js";
import "./skills-LzLwUYxz.js";
import "./path-alias-guards--u7-iWd6.js";
import "./message-channel-Uz3-Q9E0.js";
import "./sessions-Bx1XJLag.js";
import "./plugins-D8yPNTgi.js";
import "./accounts-C8pI_u-9.js";
import "./accounts-Cg8cGZPE.js";
import "./logging-CcxUDNcI.js";
import "./accounts-DBl2tRX-.js";
import "./paths-DAWfoG1N.js";
import "./chat-envelope-D3RSz140.js";
import "./net-DAPyFre2.js";
import "./tailnet-D3NBwZ0q.js";
import "./image-ops-Col_4Cje.js";
import "./pi-embedded-helpers-UK-0PB7S.js";
import "./sandbox-CncbttKI.js";
import "./tool-catalog-C04U7H3F.js";
import "./chrome-Doer_-zM.js";
import "./tailscale-djvfM56G.js";
import "./auth-BF7ZEz6Z.js";
import "./server-context-CfF4HsIY.js";
import "./paths-CSIzn_T3.js";
import "./redact-LEFt15z2.js";
import "./errors-8nIQWcYq.js";
import "./fs-safe-DS4hJvDc.js";
import "./proxy-env-BaaBkV0s.js";
import "./store--dkmRyD9.js";
import "./ports-fzkwfwGz.js";
import "./trash-G16GLJQp.js";
import "./server-middleware-84TSGaQH.js";
import "./tool-images-Dpg-bSxD.js";
import "./thinking-btBo_vAx.js";
import "./models-config-DWIgoa-v.js";
import "./model-catalog-CO9IOYpD.js";
import "./fetch-3VWBbN6j.js";
import { _ as isAudioAttachment, i as normalizeMediaAttachments, o as resolveMediaAttachmentLocalRoots, t as runAudioTranscription } from "./audio-transcription-runner-DXCMng1Q.js";
import "./fetch-guard-CcL-QGmc.js";
import "./image-r1dGy9BH.js";
import "./tool-display-DriahLIA.js";
import "./api-key-rotation-CCNR3SJy.js";
import "./proxy-fetch-CNRhfyJK.js";

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