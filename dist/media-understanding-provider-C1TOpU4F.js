import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import { t as transcribeOpenAiCompatibleAudio } from "./media-understanding-C_qxfCIa.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-wxUkQkYA.js";
import { d as DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL, s as DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL } from "./media-models-Dp3VJEzX.js";
//#region extensions/deepinfra/media-understanding-provider.ts
async function transcribeDeepInfraAudio(params) {
	return await transcribeOpenAiCompatibleAudio({
		...params,
		provider: "deepinfra",
		defaultBaseUrl: DEEPINFRA_BASE_URL,
		defaultModel: DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL
	});
}
const deepinfraMediaUnderstandingProvider = {
	id: "deepinfra",
	capabilities: ["image", "audio"],
	defaultModels: {
		image: DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL,
		audio: DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL
	},
	autoPriority: {
		image: 45,
		audio: 45
	},
	transcribeAudio: transcribeDeepInfraAudio,
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel
};
//#endregion
export { transcribeDeepInfraAudio as n, deepinfraMediaUnderstandingProvider as t };
