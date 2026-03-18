import { g as init_globals, v as logVerbose, x as shouldLogVerbose } from "./subsystem-CMvFcqxZ.js";
import "./query-expansion-BRXofpTG.js";
import "./workspace-BPUYxH8-.js";
import "./logger-C5Xia9ob.js";
import { Mt as runAudioTranscription, go as isAudioAttachment, lo as normalizeMediaAttachments, uo as resolveMediaAttachmentLocalRoots } from "./model-selection-DTQXVq3-.js";
import "./frontmatter-D0JIibvS.js";
import "./fetch-3gMSdRzB.js";
import "./boolean-Cuaw_-7j.js";
//#region src/media-understanding/audio-preflight.ts
init_globals();
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
