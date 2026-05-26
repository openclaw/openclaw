import { p as readProviderJsonObjectResponse, r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { d as requireTranscriptionText, p as resolveProviderHttpRequestConfig, t as buildAudioTranscriptionFormData, u as postTranscriptionRequest } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
import { r as normalizeElevenLabsBaseUrl, t as DEFAULT_ELEVENLABS_BASE_URL } from "./shared-B7utk7gS.js";
//#region extensions/elevenlabs/media-understanding-provider.ts
const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";
async function transcribeElevenLabsAudio(req) {
	const fetchFn = req.fetchFn ?? fetch;
	const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
	if (!apiKey) throw new Error("ElevenLabs API key missing");
	const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
		defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
		headers: req.headers,
		request: req.request,
		defaultHeaders: { "xi-api-key": apiKey },
		provider: "elevenlabs",
		api: "elevenlabs-speech-to-text",
		capability: "audio",
		transport: "media-understanding"
	});
	const form = buildAudioTranscriptionFormData({
		buffer: req.buffer,
		fileName: req.fileName,
		mime: req.mime,
		fields: {
			model_id: model,
			language_code: req.language,
			prompt: req.prompt
		}
	});
	const { response, release } = await postTranscriptionRequest({
		url: `${baseUrl}/v1/speech-to-text`,
		headers,
		body: form,
		timeoutMs: req.timeoutMs,
		fetchFn,
		allowPrivateNetwork,
		dispatcherPolicy,
		auditContext: "elevenlabs speech-to-text"
	});
	try {
		await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
		const payload = await readProviderJsonObjectResponse(response, "ElevenLabs audio transcription failed");
		return {
			text: requireTranscriptionText(typeof payload.text === "string" ? payload.text : void 0, "ElevenLabs audio transcription response missing text"),
			model
		};
	} finally {
		await release();
	}
}
const elevenLabsMediaUnderstandingProvider = {
	id: "elevenlabs",
	capabilities: ["audio"],
	defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
	autoPriority: { audio: 45 },
	transcribeAudio: transcribeElevenLabsAudio
};
//#endregion
export { transcribeElevenLabsAudio as n, elevenLabsMediaUnderstandingProvider as t };
