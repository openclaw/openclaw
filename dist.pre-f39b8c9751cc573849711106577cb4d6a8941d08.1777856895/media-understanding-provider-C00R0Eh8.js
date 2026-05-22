import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-BBIxTOw4.js";
import { t as transcribeOpenAiCompatibleAudio } from "./media-understanding-Dh596mu6.js";
import { n as OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models-BdsdM96n.js";
//#region extensions/openai/media-understanding-provider.ts
const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
async function transcribeOpenAiAudio(params) {
	return await transcribeOpenAiCompatibleAudio({
		...params,
		provider: "openai",
		defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
		defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL
	});
}
const openaiMediaUnderstandingProvider = {
	id: "openai",
	capabilities: ["image", "audio"],
	defaultModels: {
		image: "gpt-5.4-mini",
		audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL
	},
	autoPriority: {
		image: 10,
		audio: 10
	},
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
	transcribeAudio: transcribeOpenAiAudio
};
const openaiCodexMediaUnderstandingProvider = {
	id: "openai-codex",
	capabilities: ["image"],
	defaultModels: { image: "gpt-5.5" },
	autoPriority: { image: 20 },
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { openaiMediaUnderstandingProvider as n, transcribeOpenAiAudio as r, openaiCodexMediaUnderstandingProvider as t };
