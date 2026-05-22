import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-BV28ign3.js";
import { a as postJsonRequest } from "./shared-CiGprYoi.js";
import "./provider-http-CVEZetDW.js";
import "./speech-1T20a6oe.js";
import { t as XAI_BASE_URL } from "./model-definitions-BGR8zMgO.js";
import "./api-B14CPrW_.js";
//#region extensions/xai/tts.ts
const XAI_TTS_VOICES = [
	"eve",
	"ara",
	"rex",
	"sal",
	"leo",
	"una"
];
function normalizeXaiTtsBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return XAI_BASE_URL;
	return trimmed.replace(/\/+$/, "");
}
function isValidXaiTtsVoice(voice, baseUrl) {
	const normalizedBase = normalizeXaiTtsBaseUrl(baseUrl ?? process.env.XAI_BASE_URL);
	const host = normalizedBase.includes("://") ? new URL(normalizedBase).hostname : normalizedBase;
	if (!(host === "api.x.ai" || host === "api.grok.x.ai")) return true;
	return XAI_TTS_VOICES.includes(voice);
}
function normalizeXaiLanguageCode(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	const normalized = trimmed.toLowerCase();
	if (normalized === "auto" || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) return normalized;
	throw new Error(`xAI language must be "auto" or a BCP-47 tag (e.g. "en", "pt-br", "zh-cn"); got: ${normalized}`);
}
async function xaiTTS(params) {
	const { text, apiKey, baseUrl, voiceId, language: rawLanguage, speed, responseFormat = "mp3", timeoutMs } = params;
	const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";
	if (!isValidXaiTtsVoice(voiceId, baseUrl)) throw new Error(`Invalid voice: ${voiceId}`);
	const { response, release } = await postJsonRequest({
		url: `${normalizeXaiTtsBaseUrl(baseUrl)}/tts`,
		headers: new Headers({
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		}),
		body: {
			text,
			voice_id: voiceId,
			language,
			output_format: { codec: responseFormat },
			...speed != null && { speed }
		},
		timeoutMs,
		fetchFn: fetch,
		auditContext: "xai tts"
	});
	try {
		await assertOkOrThrowProviderError(response, "xAI TTS API error");
		return Buffer.from(await response.arrayBuffer());
	} finally {
		await release();
	}
}
//#endregion
export { xaiTTS as a, normalizeXaiTtsBaseUrl as i, isValidXaiTtsVoice as n, normalizeXaiLanguageCode as r, XAI_TTS_VOICES as t };
