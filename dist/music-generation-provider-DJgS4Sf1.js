import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, i as fetchProviderDownloadResponse, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./media-mime-j2Nhr7Df.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/minimax/music-generation-provider.ts
const DEFAULT_MINIMAX_MUSIC_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MUSIC_MODEL = "music-2.6";
const DEFAULT_TIMEOUT_MS = 12e4;
function resolveMinimaxMusicBaseUrl(cfg, providerId) {
	const direct = normalizeOptionalString(cfg?.models?.providers?.[providerId]?.baseUrl);
	if (!direct) return DEFAULT_MINIMAX_MUSIC_BASE_URL;
	try {
		return new URL(direct).origin;
	} catch {
		return DEFAULT_MINIMAX_MUSIC_BASE_URL;
	}
}
function assertMinimaxBaseResp(baseResp, context) {
	if (!baseResp || typeof baseResp.status_code !== "number" || baseResp.status_code === 0) return;
	throw new Error(`${context} (${baseResp.status_code}): ${baseResp.status_msg ?? "unknown error"}`);
}
function decodePossibleBinary(data) {
	const trimmed = data.trim();
	if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) return Buffer.from(trimmed, "hex");
	return Buffer.from(trimmed, "base64");
}
function decodePossibleText(data) {
	const trimmed = data.trim();
	if (!trimmed) return "";
	if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) return Buffer.from(trimmed, "hex").toString("utf8").trim();
	return trimmed;
}
function isLikelyRemoteUrl(value) {
	const trimmed = normalizeOptionalString(value);
	return Boolean(trimmed && /^https?:\/\//iu.test(trimmed));
}
async function downloadTrackFromUrl(params) {
	const response = await fetchProviderDownloadResponse({
		url: params.url,
		init: { method: "GET" },
		timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		fetchFn: params.fetchFn,
		provider: "minimax",
		requestFailedMessage: "MiniMax generated music download failed"
	});
	const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "audio/mpeg";
	const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
	return {
		buffer: Buffer.from(await response.arrayBuffer()),
		mimeType,
		fileName: `track-1.${ext}`
	};
}
function resolveMinimaxMusicModel(model) {
	const trimmed = normalizeOptionalString(model);
	if (!trimmed) return DEFAULT_MINIMAX_MUSIC_MODEL;
	return trimmed;
}
function buildMinimaxMusicProvider(providerId) {
	return {
		id: providerId,
		label: "MiniMax",
		defaultModel: DEFAULT_MINIMAX_MUSIC_MODEL,
		models: [
			DEFAULT_MINIMAX_MUSIC_MODEL,
			"music-2.6-free",
			"music-cover",
			"music-cover-free"
		],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: providerId,
			agentDir
		}),
		capabilities: {
			generate: {
				maxTracks: 1,
				supportsLyrics: true,
				supportsInstrumental: true,
				supportsFormat: true,
				supportedFormats: ["mp3"]
			},
			edit: { enabled: false }
		},
		async generateMusic(req) {
			if ((req.inputImages?.length ?? 0) > 0) throw new Error("MiniMax music generation does not support image reference inputs.");
			if (req.instrumental === true && normalizeOptionalString(req.lyrics)) throw new Error("MiniMax music generation cannot use lyrics when instrumental=true.");
			if (req.format && req.format !== "mp3") throw new Error("MiniMax music generation currently supports mp3 output only.");
			const auth = await resolveApiKeyForProvider({
				provider: providerId,
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("MiniMax API key missing");
			const fetchFn = fetch;
			const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveMinimaxMusicBaseUrl(req.cfg, providerId),
				defaultBaseUrl: DEFAULT_MINIMAX_MUSIC_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: { Authorization: `Bearer ${auth.apiKey}` },
				provider: providerId,
				capability: "audio",
				transport: "http"
			});
			const jsonHeaders = new Headers(headers);
			jsonHeaders.set("Content-Type", "application/json");
			const model = resolveMinimaxMusicModel(req.model);
			const lyrics = normalizeOptionalString(req.lyrics);
			const body = {
				model,
				prompt: req.prompt.trim(),
				...req.instrumental === true ? { is_instrumental: true } : {},
				...lyrics ? { lyrics } : req.instrumental === true ? {} : { lyrics_optimizer: true },
				output_format: "url",
				audio_setting: {
					sample_rate: 44100,
					bitrate: 256e3,
					format: "mp3"
				}
			};
			const { response: res, release } = await postJsonRequest({
				url: `${baseUrl}/v1/music_generation`,
				headers: jsonHeaders,
				body,
				timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				fetchFn,
				pinDns: false,
				allowPrivateNetwork,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(res, "MiniMax music generation failed");
				const payload = await res.json();
				assertMinimaxBaseResp(payload.base_resp, "MiniMax music generation failed");
				const audioCandidate = normalizeOptionalString(payload.audio) ?? normalizeOptionalString(payload.data?.audio);
				const audioUrl = normalizeOptionalString(payload.audio_url) || normalizeOptionalString(payload.data?.audio_url) || (isLikelyRemoteUrl(audioCandidate) ? audioCandidate : void 0);
				const inlineAudio = isLikelyRemoteUrl(audioCandidate) ? void 0 : audioCandidate;
				const lyrics = decodePossibleText(payload.lyrics ?? payload.data?.lyrics ?? "");
				const track = audioUrl ? await downloadTrackFromUrl({
					url: audioUrl,
					timeoutMs: req.timeoutMs,
					fetchFn
				}) : inlineAudio ? {
					buffer: decodePossibleBinary(inlineAudio),
					mimeType: "audio/mpeg",
					fileName: "track-1.mp3"
				} : null;
				if (!track) throw new Error("MiniMax music generation response missing audio output");
				return {
					tracks: [track],
					...lyrics ? { lyrics: [lyrics] } : {},
					model,
					metadata: {
						...normalizeOptionalString(payload.task_id) ? { taskId: normalizeOptionalString(payload.task_id) } : {},
						...audioUrl ? { audioUrl } : {},
						instrumental: req.instrumental === true,
						...lyrics ? { requestedLyrics: true } : {}
					}
				};
			} finally {
				await release();
			}
		}
	};
}
function buildMinimaxMusicGenerationProvider() {
	return buildMinimaxMusicProvider("minimax");
}
function buildMinimaxPortalMusicGenerationProvider() {
	return buildMinimaxMusicProvider("minimax-portal");
}
//#endregion
export { buildMinimaxPortalMusicGenerationProvider as n, buildMinimaxMusicGenerationProvider as t };
