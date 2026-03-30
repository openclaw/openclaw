import {
	type AudioTranscriptionRequest,
	describeImagesWithModel,
	describeImageWithModel,
	type MediaUnderstandingProvider,
	transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
	return await transcribeOpenAiCompatibleAudio({
		...params,
		defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
		defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
	});
}

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
	id: "openai",
	capabilities: ["image", "audio"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
	transcribeAudio: transcribeOpenAiAudio,
};

export const openaiCodexMediaUnderstandingProvider: MediaUnderstandingProvider =
	{
		id: "openai-codex",
		capabilities: ["image"],
		describeImage: describeImageWithModel,
		describeImages: describeImagesWithModel,
	};
