import "./agent-scope-CSkwQImO.js";
import "./paths-CH8dLxVx.js";
import { $ as shouldLogVerbose, X as logVerbose } from "./subsystem-B3k5RmW0.js";
import "./model-selection-aaCyoEgM.js";
import "./github-copilot-token-2ggfYP8J.js";
import "./env-SJcPKvdu.js";
import "./dock-BsNB9Ume.js";
import "./plugins-C0by-3Zp.js";
import "./accounts-CiF02bRw.js";
import "./bindings-DGarbPh3.js";
import "./accounts-BaJWZbRW.js";
import "./image-ops-DBNY7ywb.js";
import "./pi-model-discovery-B_t1owo2.js";
import "./message-channel-BWfFUfeB.js";
import "./pi-embedded-helpers-CXxSKQAW.js";
import "./chrome-FX-5NtUa.js";
import "./ssrf-tlVN4FBY.js";
import "./skills-CIDeIcLv.js";
import "./path-alias-guards-CCH0vtS4.js";
import "./redact-DfkHGMkU.js";
import "./errors-C6d5vwGh.js";
import "./fs-safe-BzN5BX1x.js";
import "./store-D3mH9Iqw.js";
import "./sessions-C07SLe2M.js";
import "./accounts-CDtfoCYn.js";
import "./paths-CwNoIdWe.js";
import "./tool-images-CNG9PhIy.js";
import "./thinking-ZaPrKXBc.js";
import "./image-Dh8HdczS.js";
import "./gemini-auth-DjFUqCSi.js";
import "./fetch-guard-vB1za2HG.js";
import "./local-roots-CkiB5qEM.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-D3ZcSoil.js";

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
	const providerRegistry = buildProviderRegistry(params.providers);
	const cache = createMediaAttachmentCache(attachments, { localPathRoots: resolveMediaAttachmentLocalRoots({
		cfg,
		ctx
	}) });
	try {
		const result = await runCapability({
			capability: "audio",
			cfg,
			ctx,
			attachments: cache,
			media: attachments,
			agentDir: params.agentDir,
			providerRegistry,
			config: audioConfig,
			activeModel: params.activeModel
		});
		if (!result || result.outputs.length === 0) return;
		const audioOutput = result.outputs.find((output) => output.kind === "audio.transcription");
		if (!audioOutput || !audioOutput.text) return;
		firstAudio.alreadyTranscribed = true;
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribed ${audioOutput.text.length} chars from attachment ${firstAudio.index}`);
		return audioOutput.text;
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
		return;
	} finally {
		await cache.cleanup();
	}
}

//#endregion
export { transcribeFirstAudio };