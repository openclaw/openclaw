import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { n as extractGeneratedMusicFileCandidates, t as downloadGeneratedMusicAsset } from "./music-generation-Cy0Balph.js";
//#region extensions/fal/music-generation-provider.ts
const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const FAL_ACE_STEP_MODEL = "fal-ai/ace-step/prompt-to-audio";
const FAL_STABLE_AUDIO_MODEL = "fal-ai/stable-audio-25/text-to-audio";
const DEFAULT_TIMEOUT_MS = 18e4;
const FAL_MUSIC_MODELS = [
	DEFAULT_FAL_MUSIC_MODEL,
	FAL_ACE_STEP_MODEL,
	FAL_STABLE_AUDIO_MODEL
];
function resolveFalMusicModel(model) {
	return normalizeOptionalString(model) ?? DEFAULT_FAL_MUSIC_MODEL;
}
function resolveFalMusicBaseUrl(req) {
	return normalizeOptionalString(req.cfg?.models?.providers?.fal?.baseUrl);
}
function buildFalMinimaxBody(req) {
	const lyrics = normalizeOptionalString(req.lyrics);
	if (lyrics && req.instrumental === true) throw new Error("fal MiniMax music generation cannot use lyrics when instrumental=true.");
	return {
		prompt: req.prompt,
		...lyrics ? { lyrics } : {},
		...req.instrumental === true ? { is_instrumental: true } : {},
		...!lyrics && req.instrumental !== true ? { lyrics_optimizer: true } : {},
		...typeof req.durationSeconds === "number" ? { duration: req.durationSeconds } : {},
		audio_setting: {
			sample_rate: 44100,
			bitrate: 256e3,
			format: req.format ?? "mp3"
		}
	};
}
function buildFalAceStepBody(req) {
	if (normalizeOptionalString(req.lyrics)) throw new Error("fal ACE-Step music generation does not support explicit lyrics.");
	return {
		prompt: req.prompt,
		...req.instrumental === true ? { instrumental: true } : {},
		...typeof req.durationSeconds === "number" ? { duration: req.durationSeconds } : {}
	};
}
function buildFalStableAudioBody(req) {
	if (normalizeOptionalString(req.lyrics)) throw new Error("fal Stable Audio music generation does not support explicit lyrics.");
	if (req.instrumental === true) throw new Error("fal Stable Audio music generation does not support instrumental mode.");
	return {
		prompt: req.prompt,
		...typeof req.durationSeconds === "number" ? { seconds_total: req.durationSeconds } : {}
	};
}
function buildFalMusicRequestBody(req, model) {
	if (model === FAL_ACE_STEP_MODEL) return buildFalAceStepBody(req);
	if (model === FAL_STABLE_AUDIO_MODEL) return buildFalStableAudioBody(req);
	return buildFalMinimaxBody(req);
}
function resolveFalMusicMetadata(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const metadata = {};
	for (const key of ["seed", "tags"]) {
		const value = payload[key];
		if (value !== void 0 && value !== null) metadata[key] = value;
	}
	return Object.keys(metadata).length > 0 ? metadata : void 0;
}
function buildFalMusicGenerationProvider() {
	return {
		id: "fal",
		label: "fal",
		defaultModel: DEFAULT_FAL_MUSIC_MODEL,
		models: [...FAL_MUSIC_MODELS],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "fal",
			agentDir
		}),
		capabilities: {
			generate: {
				maxTracks: 1,
				maxDurationSeconds: 240,
				supportsLyrics: true,
				supportsLyricsByModel: {
					[FAL_ACE_STEP_MODEL]: false,
					[FAL_STABLE_AUDIO_MODEL]: false
				},
				supportsInstrumental: true,
				supportsInstrumentalByModel: { [FAL_STABLE_AUDIO_MODEL]: false },
				supportsDuration: true,
				supportsFormat: true,
				supportedFormats: ["mp3", "wav"],
				supportedFormatsByModel: {
					[DEFAULT_FAL_MUSIC_MODEL]: ["mp3"],
					[FAL_ACE_STEP_MODEL]: ["wav"],
					[FAL_STABLE_AUDIO_MODEL]: ["wav"]
				}
			},
			edit: { enabled: false }
		},
		async generateMusic(req) {
			if ((req.inputImages?.length ?? 0) > 0) throw new Error("fal music generation does not support image reference inputs.");
			const auth = await resolveApiKeyForProvider({
				provider: "fal",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("fal API key missing");
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveFalMusicBaseUrl(req),
				defaultBaseUrl: DEFAULT_FAL_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Key ${auth.apiKey}`,
					"Content-Type": "application/json"
				},
				provider: "fal",
				capability: "audio",
				transport: "http"
			});
			const model = resolveFalMusicModel(req.model);
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/${model}`,
				headers,
				body: buildFalMusicRequestBody(req, model),
				timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				fetchFn: fetch,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "fal music generation failed");
				const payload = await response.json();
				const [candidate] = extractGeneratedMusicFileCandidates(payload);
				if (!candidate) throw new Error("fal music generation response missing audio output");
				const track = await downloadGeneratedMusicAsset({
					candidate,
					timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					fetchFn: fetch,
					provider: "fal",
					requestFailedMessage: "fal generated music download failed"
				});
				const lyrics = typeof payload === "object" && payload && !Array.isArray(payload) ? normalizeOptionalString(payload.lyrics) : void 0;
				return {
					tracks: [track],
					model,
					...lyrics ? { lyrics: [lyrics] } : {},
					metadata: {
						...resolveFalMusicMetadata(payload),
						...track.metadata?.url ? { audioUrl: track.metadata.url } : {},
						instrumental: req.instrumental === true,
						...req.format ? { requestedFormat: req.format } : {},
						...typeof req.durationSeconds === "number" ? { requestedDurationSeconds: req.durationSeconds } : {}
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildFalMusicGenerationProvider as t };
