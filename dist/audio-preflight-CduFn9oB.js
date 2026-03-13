import "./paths-BJV7vkaX.js";
import { S as logVerbose, T as shouldLogVerbose } from "./subsystem-DBBM_0ww.js";
import "./utils-JhJvOE-Q.js";
import { cf as resolveMediaAttachmentLocalRoots, if as runAudioTranscription, sf as normalizeMediaAttachments, vf as isAudioAttachment } from "./reply-kqyKJg4x.js";
import "./agent-scope-BwZuo7sQ.js";
import "./openclaw-root-CGu4EGX8.js";
import "./logger-B7cfoxgB.js";
import "./exec-eWx7-KTZ.js";
import "./github-copilot-token-DLfBlMRf.js";
import "./boolean-B938tROv.js";
import "./env-Cb5JzEB2.js";
import "./env-overrides-C-ZXrJon.js";
import "./registry-BbhZ8aJW.js";
import "./skills-3AC6GJLt.js";
import "./frontmatter-BngyYhS0.js";
import "./plugins-By9GTgrF.js";
import "./query-expansion-yWVZ1kDa.js";
import "./redact-ey2aG4c9.js";
import "./path-alias-guards-Cb4NBV2_.js";
import "./fetch-pr82VtKF.js";
import "./cli-utils-DMoIioWo.js";
import "./delivery-queue-DFrlUHFS.js";
import "./paths-DtZZPyOl.js";
import "./session-cost-usage-CUa3Yrhb.js";
import "./prompt-style-DxRe6Qmy.js";
import "./links-D5--5M_8.js";
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
