import "./paths-B4BZAPZh.js";
import { F as shouldLogVerbose, M as logVerbose } from "./utils-BKDT474X.js";
import "./thinking-EAliFiVK.js";
import "./agent-scope-D8K2SjR7.js";
import "./subsystem-LTWJBEIv.js";
import "./openclaw-root-PhSD0wUu.js";
import "./exec-NrPPwdAe.js";
import "./model-selection-DILdVnl8.js";
import "./github-copilot-token-nncItI8D.js";
import "./boolean-Wzu0-e0P.js";
import "./env-BqIeOdP-.js";
import "./host-env-security-lcjXF83D.js";
import "./env-vars-Duxu9t5m.js";
import "./manifest-registry-BvFf4Q1K.js";
import "./dock-C2VnAw6v.js";
import "./message-channel-C0KMGsnJ.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, s as isAudioAttachment, t as buildProviderRegistry } from "./runner-7gZudimw.js";
import "./image-D6_YAe_x.js";
import "./models-config-PcUiD3st.js";
import "./pi-model-discovery-CaAPcNJJ.js";
import "./pi-embedded-helpers-D_vwTcIu.js";
import "./sandbox-Dyhzzmyi.js";
import "./tool-catalog-BWgva5h1.js";
import "./chrome-b8UNhmri.js";
import "./tailscale-D9yyoJD-.js";
import "./ip-DK-vcRii.js";
import "./tailnet-kbXXH7kK.js";
import "./ws-zZ6eXqMi.js";
import "./auth-BcIsRQqi.js";
import "./server-context-Byjwv8su.js";
import "./frontmatter-C8fqIiB_.js";
import "./skills-dyOFjtQH.js";
import "./path-alias-guards-DkmbVRdv.js";
import "./paths-s0KCOZny.js";
import "./redact-B76y7XVG.js";
import "./errors-8IxbaLwV.js";
import "./fs-safe-BlxN6w_j.js";
import "./ssrf-DN6IsWAy.js";
import "./image-ops-CFCg0YOh.js";
import "./store-DLi2fq1F.js";
import "./ports-CAJdnzGD.js";
import "./trash-B8xEzWgw.js";
import "./server-middleware-BqKURFqJ.js";
import "./sessions-DUzDEcXs.js";
import "./plugins-B9xwwhdE.js";
import "./accounts-BDIC1FjT.js";
import "./accounts-Lsgq7_wm.js";
import "./accounts-DzNOa1lz.js";
import "./bindings-DXaMWXSi.js";
import "./logging-_TuF9Wz5.js";
import "./paths-B_bX6Iw-.js";
import "./chat-envelope-CZCr0x5F.js";
import "./tool-images-al3PxqY4.js";
import "./tool-display-CERZKWmU.js";
import "./fetch-guard-DGmDGmTu.js";
import "./api-key-rotation-C1YFO6rf.js";
import "./local-roots-BTCvOgYJ.js";
import "./model-catalog-CMTyl7fI.js";

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