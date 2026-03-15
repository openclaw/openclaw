import "./runtime-DRRlb-lt.js";
import { Fo as normalizeMediaAttachments, Io as resolveMediaAttachmentLocalRoots, Wo as isAudioAttachment, yn as runAudioTranscription } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import { f as logVerbose, h as shouldLogVerbose } from "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import "./paths-BoU0P6Xb.js";
import "./signal-Bycwzc0M.js";
import "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
//#region src/media-understanding/audio-preflight.ts
/**
* Transcribes the first audio attachment BEFORE mention checking.
* This allows voice notes to be processed in group chats with requireMention: true.
* Returns the transcript or undefined if transcription fails or no audio is found.
*/
async function transcribeFirstAudio(params) {
	const { ctx, cfg } = params;
	const audioConfig = cfg.tools?.media?.audio;
	if (!audioConfig || audioConfig.enabled === false) {return;}
	const attachments = normalizeMediaAttachments(ctx);
	if (!attachments || attachments.length === 0) {return;}
	const firstAudio = attachments.find((att) => att && isAudioAttachment(att) && !att.alreadyTranscribed);
	if (!firstAudio) {return;}
	if (shouldLogVerbose()) {logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);}
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
		if (!transcript) {return;}
		firstAudio.alreadyTranscribed = true;
		if (shouldLogVerbose()) {logVerbose(`audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`);}
		return transcript;
	} catch (err) {
		if (shouldLogVerbose()) {logVerbose(`audio-preflight: transcription failed: ${String(err)}`);}
		return;
	}
}
//#endregion
export { transcribeFirstAudio };
