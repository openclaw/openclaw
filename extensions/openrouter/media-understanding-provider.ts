import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import {
  buildOpenRouterAudioTranscriptionBody,
  postJsonResponse,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
export const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: "auto",
    audio: DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: {
    audio: 35,
  },
  describeImage: undefined,
  describeImages: undefined,
  async transcribeAudio(params) {
    const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL;
    const body = buildOpenRouterAudioTranscriptionBody({ ...params, model });
    const fetchFn = params.fetchFn ?? fetch;
    const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
      resolveProviderHttpRequestConfig({
        baseUrl: params.baseUrl,
        defaultBaseUrl: OPENROUTER_BASE_URL,
        headers: params.headers,
        request: params.request,
        defaultHeaders: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        provider: "openrouter",
        api: "openrouter-stt",
        capability: "audio",
        transport: "media-understanding",
      });

    const payload = await postJsonResponse({
      url: `${baseUrl}/audio/transcriptions`,
      headers,
      body,
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      fetchFn,
      allowPrivateNetwork,
      dispatcherPolicy,
      auditContext: "openrouter stt",
      errorLabel: "OpenRouter audio transcription failed",
      responseLabel: "openrouter.stt",
      objectResponse: true,
    });
    return {
      text: requireTranscriptionText(
        payload.text,
        "OpenRouter transcription response missing text",
      ),
      model,
    };
  },
};
