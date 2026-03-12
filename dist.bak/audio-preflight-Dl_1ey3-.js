import "./agent-scope-ET3-KDD1.js";
import "./paths-MYHBPf85.js";
import { $ as shouldLogVerbose, X as logVerbose } from "./subsystem-CYLd4dcj.js";
import "./workspace-PvhqUv3h.js";
import "./model-selection-DOYvU3hc.js";
import "./github-copilot-token-DyM1y5Pr.js";
import "./env-DioSf1y0.js";
import "./boolean-Ce2-qkSB.js";
import "./dock-B066-9Rj.js";
import "./plugins-DUx2IkaN.js";
import "./accounts-4SEfqy3O.js";
import "./bindings-TAejNrPZ.js";
import "./accounts-DhD7OMBH.js";
import "./image-ops-D98Q4dLq.js";
import "./pi-model-discovery-B1pl3ZAU.js";
import "./message-channel-rHdyUBOJ.js";
import "./pi-embedded-helpers-DLdc_PG7.js";
import "./chrome-DNpJVmqn.js";
import "./ssrf-GR1wTjsC.js";
import "./frontmatter-CthhXKqf.js";
import "./skills-D8Wcotgx.js";
import "./path-alias-guards-Ck6h4R-2.js";
import "./redact-BsXsyykh.js";
import "./errors-kKzMhHcT.js";
import "./fs-safe-D8h6zmZn.js";
import "./store-BPoOdDyW.js";
import "./sessions-BLHmBFe6.js";
import "./accounts-CpA_IJ0G.js";
import "./paths-6XrpQmMB.js";
import "./tool-images-C4bZaIjc.js";
import "./thinking-CJoHneR6.js";
import "./image-DnmlghbV.js";
import "./gemini-auth-BoOrasN3.js";
import "./fetch-guard-2JREkJbB.js";
import "./local-roots-BetgXXEI.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-BE6_rpZS.js";

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