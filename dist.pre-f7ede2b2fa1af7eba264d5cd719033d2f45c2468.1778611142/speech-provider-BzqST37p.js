import { n as asObject } from "./provider-http-errors-LZzlrUs8.js";
import { t as createOpenAiCompatibleSpeechProvider } from "./speech-Dm-ite1c.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-DR332h6r.js";
import { f as DEFAULT_DEEPINFRA_TTS_MODEL, g as normalizeDeepInfraModelRef, p as DEFAULT_DEEPINFRA_TTS_VOICE, r as DEEPINFRA_TTS_MODELS } from "./media-models-DH_AfFuJ.js";
//#region extensions/deepinfra/speech-provider.ts
const DEEPINFRA_TTS_RESPONSE_FORMATS = [
	"mp3",
	"opus",
	"flac",
	"wav",
	"pcm"
];
function buildDeepInfraSpeechProvider() {
	return createOpenAiCompatibleSpeechProvider({
		id: "deepinfra",
		label: "DeepInfra",
		autoSelectOrder: 45,
		models: DEEPINFRA_TTS_MODELS,
		voices: [DEFAULT_DEEPINFRA_TTS_VOICE],
		defaultModel: DEFAULT_DEEPINFRA_TTS_MODEL,
		defaultVoice: DEFAULT_DEEPINFRA_TTS_VOICE,
		defaultBaseUrl: DEEPINFRA_BASE_URL,
		envKey: "DEEPINFRA_API_KEY",
		responseFormats: DEEPINFRA_TTS_RESPONSE_FORMATS,
		defaultResponseFormat: "mp3",
		voiceCompatibleResponseFormats: ["mp3", "opus"],
		baseUrlPolicy: { kind: "trim-trailing-slash" },
		normalizeModel: normalizeDeepInfraModelRef,
		apiErrorLabel: "DeepInfra TTS API error",
		missingApiKeyError: "DeepInfra API key missing",
		readExtraConfig: (raw) => ({ extraBody: asObject(raw?.extraBody) }),
		extraJsonBodyFields: [{
			configKey: "extraBody",
			requestKey: "extra_body"
		}]
	});
}
//#endregion
export { buildDeepInfraSpeechProvider as t };
