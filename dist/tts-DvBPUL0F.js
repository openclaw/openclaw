import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
import "./speech-DNHVYL_R.js";
import { t as XAI_BASE_URL } from "./model-definitions-hd9WbvLm.js";
import "./api-D1MlRYzF.js";
import { n as xaiUserAgentHeaderFor } from "./xai-user-agent-C3BZpeV5.js";
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
	if (!((normalizedBase.includes("://") ? new URL(normalizedBase).hostname : normalizedBase) === "api.x.ai")) return true;
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
	const ttsBaseUrl = normalizeXaiTtsBaseUrl(baseUrl);
	const { response, release } = await postJsonRequest({
		url: `${ttsBaseUrl}/tts`,
		headers: new Headers({
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...xaiUserAgentHeaderFor(ttsBaseUrl)
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
