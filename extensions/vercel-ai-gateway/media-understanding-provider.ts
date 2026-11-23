import { mimeTypeFromFilePath, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import {
  postJsonResponse,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { VERCEL_AI_GATEWAY_BASE_URL, VERCEL_AI_GATEWAY_PROVIDER_ID } from "./models.js";

const DEFAULT_VERCEL_AI_GATEWAY_AUDIO_TRANSCRIPTION_MODEL = "openai/gpt-transcribe";

// AI Gateway's native transcription endpoint, as called by @ai-sdk/gateway's
// GatewayTranscriptionModel. The Gateway has no OpenAI-style /v1/audio/transcriptions route.
export const vercelAiGatewayMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: VERCEL_AI_GATEWAY_PROVIDER_ID,
  capabilities: ["audio"],
  defaultModels: {
    audio: DEFAULT_VERCEL_AI_GATEWAY_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: {
    audio: 35,
  },
  async transcribeAudio(params) {
    const model = params.model?.trim() || DEFAULT_VERCEL_AI_GATEWAY_AUDIO_TRANSCRIPTION_MODEL;
    const mediaType = normalizeMimeType(params.mime) ?? mimeTypeFromFilePath(params.fileName);
    if (!mediaType) {
      throw new Error(
        `Vercel AI Gateway STT could not resolve audio media type from mime "${params.mime ?? ""}" and file "${params.fileName ?? ""}"`,
      );
    }
    const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
      resolveProviderHttpRequestConfig({
        baseUrl: params.baseUrl,
        defaultBaseUrl: VERCEL_AI_GATEWAY_BASE_URL,
        headers: params.headers,
        request: params.request,
        defaultHeaders: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
          "ai-transcription-model-specification-version": "4",
          "ai-model-id": model,
        },
        provider: VERCEL_AI_GATEWAY_PROVIDER_ID,
        api: "vercel-ai-gateway-transcription",
        capability: "audio",
        transport: "media-understanding",
      });
    // The Gateway routes by provider; providerOptions are keyed by the model's provider
    // prefix (openai/gpt-transcribe -> openai), matching the AI SDK contract.
    const providerSlug = model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
    const providerOptions = {
      ...(params.language?.trim() ? { language: params.language.trim() } : {}),
      ...(params.prompt?.trim() ? { prompt: params.prompt.trim() } : {}),
      ...params.query,
    };

    const payload = await postJsonResponse({
      url: `${baseUrl}/v4/ai/transcription-model`,
      headers,
      body: {
        audio: params.buffer.toString("base64"),
        mediaType,
        ...(providerSlug && Object.keys(providerOptions).length > 0
          ? { providerOptions: { [providerSlug]: providerOptions } }
          : {}),
      },
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      fetchFn: params.fetchFn ?? fetch,
      allowPrivateNetwork,
      dispatcherPolicy,
      auditContext: "vercel-ai-gateway stt",
      errorLabel: "Vercel AI Gateway audio transcription failed",
      responseLabel: "vercel-ai-gateway.stt",
      objectResponse: true,
    });
    return {
      text: requireTranscriptionText(
        payload.text,
        "Vercel AI Gateway transcription response missing text",
      ),
      model,
    };
  },
};
