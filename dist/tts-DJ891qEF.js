import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-C90BH-le.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./speech-core-DVjAqDEd.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/azure-speech/tts.ts
const DEFAULT_AZURE_SPEECH_VOICE = "en-US-JennyNeural";
const DEFAULT_AZURE_SPEECH_LANG = "en-US";
const DEFAULT_AZURE_SPEECH_AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT = "ogg-24khz-16bit-mono-opus";
const DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT = "raw-8khz-8bit-mono-mulaw";
function normalizeAzureSpeechBaseUrl(params) {
	const configured = normalizeOptionalString(params.baseUrl) ?? normalizeOptionalString(params.endpoint);
	if (configured) return configured.replace(/\/+$/, "").replace(/\/cognitiveservices\/v1$/i, "");
	const region = normalizeOptionalString(params.region);
	return region ? `https://${region}.tts.speech.microsoft.com` : void 0;
}
function azureSpeechUrl(params) {
	const baseUrl = normalizeAzureSpeechBaseUrl(params);
	if (!baseUrl) throw new Error("Azure Speech region or endpoint missing");
	return `${baseUrl}${params.path}`;
}
function escapeXmlText(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeXmlAttr(value) {
	return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function buildAzureSpeechSsml(params) {
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXmlAttr(normalizeOptionalString(params.lang) ?? "en-US")}"><voice name="${escapeXmlAttr(params.voice)}">${escapeXmlText(params.text)}</voice></speak>`;
}
function inferAzureSpeechFileExtension(outputFormat) {
	const normalized = outputFormat.toLowerCase();
	if (normalized.includes("mp3")) return ".mp3";
	if (normalized.startsWith("ogg-")) return ".ogg";
	if (normalized.startsWith("webm-")) return ".webm";
	if (normalized.startsWith("riff-")) return ".wav";
	if (normalized.startsWith("raw-")) return ".pcm";
	if (normalized.startsWith("amr-")) return ".amr";
	return ".audio";
}
function isAzureSpeechVoiceCompatible(outputFormat) {
	const normalized = outputFormat.toLowerCase();
	return normalized.startsWith("ogg-") && normalized.includes("opus");
}
function formatVoiceDescription(entry) {
	const parts = [...entry.VoiceTag?.TailoredScenarios ?? [], ...entry.VoiceTag?.VoicePersonalities ?? []].filter((value) => normalizeOptionalString(value) !== void 0);
	return parts.length > 0 ? parts.join(", ") : void 0;
}
function isDeprecatedVoice(entry) {
	if (entry.IsDeprecated === true) return true;
	if (typeof entry.IsDeprecated === "string" && entry.IsDeprecated.toLowerCase() === "true") return true;
	const status = normalizeOptionalString(entry.Status)?.toLowerCase();
	return status === "deprecated" || status === "retired" || status === "disabled";
}
async function listAzureSpeechVoices(params) {
	const url = azureSpeechUrl({
		...params,
		path: "/cognitiveservices/voices/list"
	});
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: {
			method: "GET",
			headers: { "Ocp-Apim-Subscription-Key": params.apiKey }
		},
		timeoutMs: params.timeoutMs,
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
		auditContext: "azure-speech.voices"
	});
	try {
		await assertOkOrThrowProviderError(response, "Azure Speech voices API error");
		const voices = await response.json();
		return Array.isArray(voices) ? voices.filter((voice) => !isDeprecatedVoice(voice)).map((voice) => ({
			id: normalizeOptionalString(voice.ShortName) ?? "",
			name: normalizeOptionalString(voice.DisplayName) ?? normalizeOptionalString(voice.LocalName),
			description: formatVoiceDescription(voice),
			locale: normalizeOptionalString(voice.Locale),
			gender: normalizeOptionalString(voice.Gender),
			personalities: voice.VoiceTag?.VoicePersonalities?.filter((value) => normalizeOptionalString(value) !== void 0)
		})).filter((voice) => voice.id.length > 0) : [];
	} finally {
		await release();
	}
}
async function azureSpeechTTS(params) {
	const voice = normalizeOptionalString(params.voice) ?? "en-US-JennyNeural";
	const outputFormat = normalizeOptionalString(params.outputFormat) ?? "audio-24khz-48kbitrate-mono-mp3";
	const url = azureSpeechUrl({
		...params,
		path: "/cognitiveservices/v1"
	});
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/ssml+xml",
				"Ocp-Apim-Subscription-Key": params.apiKey,
				"X-Microsoft-OutputFormat": outputFormat,
				"User-Agent": "OpenClaw"
			},
			body: buildAzureSpeechSsml({
				text: params.text,
				voice,
				lang: params.lang
			})
		},
		timeoutMs: params.timeoutMs,
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
		auditContext: "azure-speech.tts"
	});
	try {
		await assertOkOrThrowProviderError(response, "Azure Speech TTS API error");
		return Buffer.from(await response.arrayBuffer());
	} finally {
		await release();
	}
}
//#endregion
export { DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT as a, inferAzureSpeechFileExtension as c, normalizeAzureSpeechBaseUrl as d, DEFAULT_AZURE_SPEECH_VOICE as i, isAzureSpeechVoiceCompatible as l, DEFAULT_AZURE_SPEECH_LANG as n, azureSpeechTTS as o, DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT as r, buildAzureSpeechSsml as s, DEFAULT_AZURE_SPEECH_AUDIO_FORMAT as t, listAzureSpeechVoices as u };
