import { r as describeImagesWithModel, t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import { i as resolveMediaUnderstandingString, n as buildOpenAiCompatibleVideoRequestBody, r as coerceOpenAiCompatibleVideoText } from "./media-understanding-C_qxfCIa.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
import { r as MOONSHOT_DEFAULT_MODEL_ID } from "./provider-catalog-0bGkrp95.js";
//#region extensions/moonshot/media-understanding-provider.ts
const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MOONSHOT_VIDEO_MODEL = MOONSHOT_DEFAULT_MODEL_ID;
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";
async function describeMoonshotVideo(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const model = resolveMediaUnderstandingString(params.model, DEFAULT_MOONSHOT_VIDEO_MODEL);
	const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
	const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_MOONSHOT_VIDEO_PROMPT);
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: params.baseUrl,
		defaultBaseUrl: DEFAULT_MOONSHOT_VIDEO_BASE_URL,
		headers: params.headers,
		request: params.request,
		defaultHeaders: {
			"content-type": "application/json",
			authorization: `Bearer ${params.apiKey}`
		},
		provider: "moonshot",
		api: "openai-completions",
		capability: "video",
		transport: "media-understanding"
	});
	const { response: res, release } = await postJsonRequest({
		url: `${baseUrl}/chat/completions`,
		headers,
		body: buildOpenAiCompatibleVideoRequestBody({
			model,
			prompt,
			mime,
			buffer: params.buffer
		}),
		timeoutMs: params.timeoutMs,
		fetchFn,
		allowPrivateNetwork,
		dispatcherPolicy
	});
	try {
		await assertOkOrThrowHttpError(res, "Moonshot video description failed");
		const text = coerceOpenAiCompatibleVideoText(await res.json());
		if (!text) throw new Error("Moonshot video description response missing content");
		return {
			text,
			model
		};
	} finally {
		await release();
	}
}
const moonshotMediaUnderstandingProvider = {
	id: "moonshot",
	capabilities: ["image", "video"],
	defaultModels: {
		image: MOONSHOT_DEFAULT_MODEL_ID,
		video: DEFAULT_MOONSHOT_VIDEO_MODEL
	},
	autoPriority: { video: 20 },
	describeImage: describeImageWithModel,
	describeImages: describeImagesWithModel,
	describeVideo: describeMoonshotVideo
};
//#endregion
export { moonshotMediaUnderstandingProvider as n, describeMoonshotVideo as t };
