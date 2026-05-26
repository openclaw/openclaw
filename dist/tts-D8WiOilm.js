import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./ssrf-runtime-Be2o3zD7.js";
//#region extensions/inworld/tts.ts
const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
const DEFAULT_INWORLD_VOICE_ID = "Sarah";
const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-max";
const INWORLD_TTS_MODELS = [
	"inworld-tts-1.5-max",
	"inworld-tts-1.5-mini",
	"inworld-tts-1-max",
	"inworld-tts-1"
];
function normalizeInworldBaseUrl(baseUrl) {
	return (baseUrl?.trim())?.replace(/\/+$/, "") || DEFAULT_INWORLD_BASE_URL;
}
function ssrfPolicyFromInworldBaseUrl(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return { hostnameAllowlist: [parsed.hostname] };
	} catch {
		return;
	}
}
/**
* Calls the Inworld streaming TTS endpoint and concatenates every audio chunk
* into a single buffer. The stream returns newline-delimited JSON, each line
* carrying base64 audio in `result.audioContent`.
*/
async function inworldTTS(params) {
	const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
	const url = `${baseUrl}/tts/v1/voice:stream`;
	const requestBody = JSON.stringify({
		text: params.text,
		voiceId: params.voiceId ?? "Sarah",
		modelId: params.modelId ?? "inworld-tts-1.5-max",
		audioConfig: {
			audioEncoding: params.audioEncoding ?? "MP3",
			...params.sampleRateHertz && { sampleRateHertz: params.sampleRateHertz }
		},
		...params.temperature != null && { temperature: params.temperature }
	});
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${params.apiKey}`
			},
			body: requestBody
		},
		timeoutMs: params.timeoutMs,
		policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
		auditContext: "inworld-tts"
	});
	try {
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`Inworld TTS API error (${response.status}): ${errorBody}`);
		}
		const body = await response.text();
		const chunks = [];
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Inworld TTS stream parse error: unexpected non-JSON line: ${trimmed.slice(0, 80)}`);
			}
			if (parsed.error) throw new Error(`Inworld TTS stream error (${parsed.error.code}): ${parsed.error.message}`);
			if (parsed.result?.audioContent) chunks.push(Buffer.from(parsed.result.audioContent, "base64"));
		}
		if (chunks.length === 0) throw new Error("Inworld TTS returned no audio data");
		return Buffer.concat(chunks);
	} finally {
		await release();
	}
}
async function listInworldVoices(params) {
	const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
	const { response, release } = await fetchWithSsrFGuard({
		url: `${baseUrl}/voices/v1/voices${params.language ? `?languages=${encodeURIComponent(params.language)}` : ""}`,
		init: {
			method: "GET",
			headers: { Authorization: `Basic ${params.apiKey}` }
		},
		timeoutMs: params.timeoutMs,
		policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
		auditContext: "inworld-voices"
	});
	try {
		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(`Inworld voices API error (${response.status}): ${errorBody}`);
		}
		const json = await response.json();
		return Array.isArray(json.voices) ? json.voices.map((voice) => ({
			id: voice.voiceId?.trim() ?? "",
			name: voice.displayName?.trim() || void 0,
			description: voice.description?.trim() || void 0,
			locale: voice.langCode || void 0,
			gender: voice.tags?.find((t) => t === "male" || t === "female") || void 0
		})).filter((voice) => voice.id.length > 0) : [];
	} finally {
		await release();
	}
}
//#endregion
export { listInworldVoices as a, inworldTTS as i, DEFAULT_INWORLD_VOICE_ID as n, normalizeInworldBaseUrl as o, INWORLD_TTS_MODELS as r, DEFAULT_INWORLD_MODEL_ID as t };
