export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;

export const OPENAI_TTS_MODELS = [
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
] as const;

export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

export function normalizeOpenAITtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export function isCustomOpenAITtsBaseUrl(baseUrl?: string): boolean {
  return (
    normalizeOpenAITtsBaseUrl(baseUrl ?? process.env.OPENAI_TTS_BASE_URL) !==
    DEFAULT_OPENAI_BASE_URL
  );
}

export function isValidOpenAIModel(model: string, baseUrl?: string): boolean {
  if (isCustomOpenAITtsBaseUrl(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_MODELS.some((candidate) => candidate === model);
}

export function isValidOpenAIVoice(voice: string, baseUrl?: string): voice is OpenAiTtsVoice {
  if (isCustomOpenAITtsBaseUrl(baseUrl)) {
    return true;
  }
  return OPENAI_TTS_VOICES.some((candidate) => candidate === voice);
}

function resolveOpenAITtsInstructions(
  model: string,
  instructions?: string,
  baseUrl?: string,
): string | undefined {
  const next = instructions?.trim();
  if (!next) {
    return undefined;
  }
  if (baseUrl !== undefined && isCustomOpenAITtsBaseUrl(baseUrl)) {
    return next;
  }
  return model.includes("gpt-4o-mini-tts") ? next : undefined;
}

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

export async function openaiTTS({
  text,
  apiKey,
  baseUrl,
  model,
  voice,
  speed,
  instructions,
  responseFormat,
  extraBody,
  timeoutMs,
  maxBytes = DEFAULT_TTS_MAX_BYTES,
}: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat: "mp3" | "opus" | "pcm" | "wav";
  extraBody?: Record<string, unknown>;
  timeoutMs: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const effectiveInstructions = resolveOpenAITtsInstructions(model, instructions, baseUrl);

  if (!isValidOpenAIModel(model, baseUrl)) {
    throw new Error(`Invalid model: ${model}`);
  }
  if (!isValidOpenAIVoice(voice, baseUrl)) {
    throw new Error(`Invalid voice: ${voice}`);
  }
  const {
    assertOkOrThrowProviderError,
    readProviderBinaryResponse,
    resolveProviderRequestHeaders,
  } = await import("openclaw/plugin-sdk/provider-http");
  const proxyCaptureSdk = await import("openclaw/plugin-sdk/proxy-capture");
  // The shipped 2026.9.6 host lacks async diagnostics; remove optionality when the minimum advances.
  const captureHost: Partial<Pick<typeof proxyCaptureSdk, "captureHttpExchangeAsync">> =
    proxyCaptureSdk;
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");

  const requestHeaders = resolveProviderRequestHeaders({
    provider: "openai",
    baseUrl,
    capability: "audio",
    transport: "http",
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  }) ?? {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const requestBody = JSON.stringify({
    model,
    input: text,
    voice,
    response_format: responseFormat,
    ...(speed != null && { speed }),
    ...(effectiveInstructions != null && { instructions: effectiveInstructions }),
    ...(extraBody == null ? {} : sanitizeExtraBodyRecord(extraBody)),
  });
  const requestUrl = `${baseUrl}/audio/speech`;
  const debugProxyFetchPatchInstalled = proxyCaptureSdk.isDebugProxyGlobalFetchPatchInstalled();
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    init: {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    capture: false,
    pinDns: debugProxyFetchPatchInstalled ? false : undefined,
    auditContext: "openai-tts",
  });
  try {
    if (!debugProxyFetchPatchInstalled) {
      // Finalization retains capture failures; observe the Promise returned by the SDK view.
      void captureHost
        .captureHttpExchangeAsync?.({
          url: requestUrl,
          method: "POST",
          requestHeaders,
          requestBody,
          response,
          transport: "http",
          meta: {
            provider: "openai",
            capability: "tts",
          },
        })
        .catch(() => {});
    }

    await assertOkOrThrowProviderError(response, "OpenAI TTS API error");

    return await readProviderBinaryResponse(response, "OpenAI TTS API error", "audio", {
      maxBytes,
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`OpenAI TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}
