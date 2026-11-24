import { mimeTypeFromFilePath, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import type {
  AudioTranscriptionConfigContext,
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
  resolveApiKeyForProvider,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { getCachedLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  postJsonResponse,
  providerOperationRetryConfig,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_PROVIDER_ID,
  vercelAiGatewayFetchGuard,
} from "./models.js";

const DEFAULT_VERCEL_AI_GATEWAY_AUDIO_TRANSCRIPTION_MODEL = "openai/gpt-transcribe";
const MODEL_ELIGIBILITY_CACHE_TTL_MS = 5 * 60_000;
const MODEL_ELIGIBILITY_TIMEOUT_MS = 5000;

// The standard language hint uses each upstream SDK's option name. ElevenLabs reads
// `languageCode`; the other Gateway transcription providers read `language`.
const LANGUAGE_OPTION_BY_PROVIDER: Readonly<Record<string, string>> = {
  elevenlabs: "languageCode",
};

function resolveTranscriptionModel(model: string | undefined): string {
  return model?.trim() || DEFAULT_VERCEL_AI_GATEWAY_AUDIO_TRANSCRIPTION_MODEL;
}

async function resolveVercelAiGatewayAudioAuth(context: AudioTranscriptionConfigContext) {
  try {
    const auth = await resolveApiKeyForProvider({
      provider: VERCEL_AI_GATEWAY_PROVIDER_ID,
      capability: "audio-transcription",
      cfg: context.cfg,
      agentDir: context.agentDir,
      workspaceDir: context.workspaceDir,
      profileId: context.profile,
      preferredProfile: context.preferredProfile,
      lockedProfile: Boolean(context.profile),
    });
    const apiKey = auth.apiKey?.trim();
    if (!apiKey) {
      throw new Error(`No API key resolved for provider "${VERCEL_AI_GATEWAY_PROVIDER_ID}".`);
    }
    return { ok: true as const, value: apiKey };
  } catch (error) {
    return { ok: false as const, error };
  }
}

// Token Pass and other scoped keys list only the models they can call, and reject
// audio models with 403. Checking the key's own model list before uploading keeps
// automatic selection free to try another transcriber instead of failing the upload.
async function assertTranscriptionModelAvailable(params: {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<void> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: VERCEL_AI_GATEWAY_PROVIDER_ID,
    endpoint: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
    apiKey: params.apiKey,
    fetchGuard: vercelAiGatewayFetchGuard,
    timeoutMs: MODEL_ELIGIBILITY_TIMEOUT_MS,
    ttlMs: MODEL_ELIGIBILITY_CACHE_TTL_MS,
    auditContext: "vercel-ai-gateway.stt-eligibility",
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const available = rows.some(
    (row) =>
      isRecord(row) &&
      row.id === params.model &&
      (row.type === undefined || row.type === "transcription"),
  );
  if (!available) {
    throw new Error(
      `Vercel AI Gateway key cannot use transcription model "${params.model}" (not in this key's model list; Token Pass keys exclude audio models).`,
    );
  }
}

// Rotation can move from the primary key to environment-configured keys on rate limits.
// Every key admitted to rotation passes the same model check, so a scoped secondary key
// never receives the upload and ends rotation with a model-scope 403. The primary key
// must be eligible; ineligible or unreadable secondary keys are dropped.
async function collectEligibleTranscriptionKeys(params: {
  primaryApiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; value: string[] } | { ok: false; error: unknown }> {
  const candidates = collectProviderApiKeysForExecution({
    provider: VERCEL_AI_GATEWAY_PROVIDER_ID,
    primaryApiKey: params.primaryApiKey,
  });
  const eligible: string[] = [];
  for (const apiKey of candidates) {
    try {
      await assertTranscriptionModelAvailable({
        apiKey,
        model: params.model,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      eligible.push(apiKey);
    } catch (error) {
      if (apiKey === params.primaryApiKey) {
        return { ok: false, error };
      }
    }
  }
  return { ok: true, value: eligible };
}

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
  isAudioConfigured: async (context) => (await resolveVercelAiGatewayAudioAuth(context)).ok,
  async transcribeAudioWithContext(context) {
    const model = resolveTranscriptionModel(context.model);
    const prepared = await resolveVercelAiGatewayAudioAuth(context);
    if (!prepared.ok) {
      return prepared;
    }
    const eligibility = await collectEligibleTranscriptionKeys({
      primaryApiKey: prepared.value,
      model,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (!eligibility.ok) {
      // This result is exclusively a rejection before uploading audio. Upload and HTTP
      // failures below throw, so automatic selection never resends the file elsewhere.
      return eligibility;
    }
    const value = await executeWithApiKeyRotation({
      provider: VERCEL_AI_GATEWAY_PROVIDER_ID,
      apiKeys: eligibility.value,
      transientRetry: providerOperationRetryConfig("read"),
      execute: (apiKey) => transcribeVercelAiGatewayAudio({ ...context, model, apiKey }),
    });
    return { ok: true, value };
  },
  transcribeAudio: (params) => transcribeVercelAiGatewayAudio(params),
};

async function transcribeVercelAiGatewayAudio(params: AudioTranscriptionRequest) {
  const model = resolveTranscriptionModel(params.model);
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
  const languageOption = (providerSlug && LANGUAGE_OPTION_BY_PROVIDER[providerSlug]) || "language";
  const providerOptions = {
    ...(params.language?.trim() ? { [languageOption]: params.language.trim() } : {}),
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
}
