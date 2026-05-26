import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import "./media-understanding-C_qxfCIa.js";
import { i as assertOkOrThrowProviderError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
import { n as normalizeGoogleModelId } from "./model-id-CN9oH8ae.js";
import { t as DEFAULT_GOOGLE_API_BASE_URL } from "./provider-policy-C3QGAGLZ.js";
import { t as resolveGoogleGenerativeAiHttpRequestConfig } from "./api-B6GzhKwj.js";
import "./runtime-api-Du5nnYkH.js";
//#region extensions/google/media-understanding-provider.ts
const DEFAULT_GOOGLE_AUDIO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
const DEFAULT_GOOGLE_VIDEO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";
async function generateGeminiInlineDataText(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const model = (() => {
		const trimmed = params.model?.trim();
		if (!trimmed) return params.defaultModel;
		return normalizeGoogleModelId(trimmed);
	})();
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveGoogleGenerativeAiHttpRequestConfig({
		apiKey: params.apiKey,
		baseUrl: params.baseUrl,
		headers: params.headers,
		request: params.request,
		capability: params.defaultMime.startsWith("audio/") ? "audio" : "video",
		transport: "media-understanding"
	});
	const { response: res, release } = await postJsonRequest({
		url: `${baseUrl ?? params.defaultBaseUrl}/models/${model}:generateContent`,
		headers,
		body: { contents: [{
			role: "user",
			parts: [{ text: params.prompt?.trim() || params.defaultPrompt }, { inline_data: {
				mime_type: params.mime ?? params.defaultMime,
				data: params.buffer.toString("base64")
			} }]
		}] },
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork,
		dispatcherPolicy
	});
	try {
		await assertOkOrThrowProviderError(res, params.httpErrorLabel);
		const text = ((await res.json()).candidates?.[0]?.content?.parts ?? []).map((part) => part?.text?.trim()).filter(Boolean).join("\n");
		if (!text) throw new Error(params.missingTextError);
		return {
			text,
			model
		};
	} finally {
		await release();
	}
}
async function transcribeGeminiAudio(params) {
	const { text, model } = await generateGeminiInlineDataText({
		...params,
		defaultBaseUrl: DEFAULT_GOOGLE_AUDIO_BASE_URL,
		defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
		defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
		defaultMime: "audio/wav",
		httpErrorLabel: "Audio transcription failed",
		missingTextError: "Audio transcription response missing text"
	});
	return {
		text,
		model
	};
}
async function describeGeminiVideo(params) {
	const { text, model } = await generateGeminiInlineDataText({
		...params,
		defaultBaseUrl: DEFAULT_GOOGLE_VIDEO_BASE_URL,
		defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
		defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
		defaultMime: "video/mp4",
		httpErrorLabel: "Video description failed",
		missingTextError: "Video description response missing text"
	});
	return {
		text,
		model
	};
}
const googleMediaUnderstandingProvider = {
	id: "google",
	capabilities: [
		"image",
		"audio",
		"video"
	],
	defaultModels: {
		image: DEFAULT_GOOGLE_VIDEO_MODEL,
		audio: DEFAULT_GOOGLE_AUDIO_MODEL,
		video: DEFAULT_GOOGLE_VIDEO_MODEL
	},
	autoPriority: {
		image: 30,
		audio: 40,
		video: 10
	},
	nativeDocumentInputs: ["pdf"],
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
	transcribeAudio: transcribeGeminiAudio,
	describeVideo: describeGeminiVideo
};
//#endregion
export { transcribeGeminiAudio as a, googleMediaUnderstandingProvider as i, DEFAULT_GOOGLE_VIDEO_BASE_URL as n, describeGeminiVideo as r, DEFAULT_GOOGLE_AUDIO_BASE_URL as t };
