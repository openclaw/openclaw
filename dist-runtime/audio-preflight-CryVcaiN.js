import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-BZ4hHpx2.js";
import "./logger-CRwcgB9y.js";
import "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import { f as logVerbose, h as shouldLogVerbose } from "./subsystem-CsP80x3t.js";
import "./utils-o1tyfnZ_.js";
import "./fetch-Dx857jUp.js";
import "./retry-BY_ggjbn.js";
import "./agent-scope-DV_aCIyi.js";
import "./exec-BLi45_38.js";
import "./logger-Bsnck4bK.js";
import "./paths-OqPpu-UR.js";
import { Ss as isAudioAttachment, hs as resolveMediaAttachmentLocalRoots, ms as normalizeMediaAttachments, sn as runAudioTranscription } from "./auth-profiles-CuJtivJK.js";
import "./profiles-CV7WLKIX.js";
import "./fetch-D2ZOzaXt.js";
import "./external-content-vZzOHxnd.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-l-LpSxGW.js";
import "./pairing-token-DKpN4qO0.js";
import "./query-expansion-txqQdNIf.js";
import "./redact-BefI-5cC.js";
import "./mime-33LCeGh-.js";
import "./typebox-BmZP6XXv.js";
import "./web-search-plugin-factory-DStYVW2B.js";
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
