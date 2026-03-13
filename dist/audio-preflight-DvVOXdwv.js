import { S as logVerbose, T as shouldLogVerbose } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { Tf as resolveMediaAttachmentLocalRoots, kg as isAudioAttachment, wf as normalizeMediaAttachments, xf as runAudioTranscription } from "./auth-profiles-CAw5gP6f.js";
import "./agent-scope-DBEC2O3x.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import "./links-BpBLDDXV.js";
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
