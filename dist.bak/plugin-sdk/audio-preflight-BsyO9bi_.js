import "./accounts-B5SFFfMD.js";
import "./paths-DVWx7USN.js";
import "./github-copilot-token-Cg0YPPSu.js";
import "./config-DunvA-uZ.js";
import { $ as logVerbose, nt as shouldLogVerbose } from "./subsystem-B0uKDnzH.js";
import "./command-format-BVkj1PMu.js";
import "./agent-scope-DgbjWdYv.js";
import "./dock-k3PRCoNo.js";
import "./message-channel-DRVy6F53.js";
import "./sessions-Bk9xxDOW.js";
import "./plugins-D_msJzdO.js";
import "./accounts-qAECR2Rl.js";
import "./accounts-B2na3IIx.js";
import "./bindings-ZfMMaVYO.js";
import "./paths-DErPP5Pi.js";
import "./redact-NupjZUMH.js";
import "./errors-WrhqJ_d4.js";
import "./path-alias-guards-s-QPXGlx.js";
import "./fs-safe-g5ELf_pw.js";
import "./image-ops-C5t1cRmC.js";
import "./ssrf-D07_rJxG.js";
import "./fetch-guard-Bj06Hz72.js";
import "./local-roots-DbFvAaXE.js";
import "./tool-images-ByaQlJ8J.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-D9LIwAWg.js";
import "./skills-CZtyxj0N.js";
import "./chrome-6OMjVEAh.js";
import "./store-VrLJabdN.js";
import "./pi-embedded-helpers-VjN-WAoA.js";
import "./thinking-BpFZfHN9.js";
import "./image-yuQ0CZRJ.js";
import "./pi-model-discovery-CSkMq2Ck.js";
import "./api-key-rotation-LLLKIUZ5.js";

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