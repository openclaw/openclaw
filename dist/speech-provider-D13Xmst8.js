import { n as asObject } from "./provider-http-errors-C90BH-le.js";
import { t as createOpenAiCompatibleSpeechProvider } from "./speech-DNHVYL_R.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-wxUkQkYA.js";
import { f as DEFAULT_DEEPINFRA_TTS_MODEL, g as normalizeDeepInfraModelRef, p as DEFAULT_DEEPINFRA_TTS_VOICE, r as DEEPINFRA_TTS_MODELS } from "./media-models-Dp3VJEzX.js";
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
