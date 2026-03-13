import "./github-copilot-token-D_-ww7kX.js";
import "./query-expansion-CXt6YRxc.js";
import "./paths-hfkBoC7i.js";
import { d as logVerbose, m as shouldLogVerbose } from "./subsystem-2phE7Tdr.js";
import "./workspace-B3nm_eCU.js";
import "./logger-BYA-BLD7.js";
import { Gn as normalizeMediaAttachments, Hn as runAudioTranscription, Kn as resolveMediaAttachmentLocalRoots, Xn as isAudioAttachment } from "./model-selection-DOMbg4qO.js";
import "./boolean-Cuaw_-7j.js";
import "./fetch-vIL6gZu4.js";
import "./frontmatter-CEejIjxx.js";
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
