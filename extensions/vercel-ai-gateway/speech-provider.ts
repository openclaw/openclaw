import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { createSpeechDirectiveParser } from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Kept local: models.ts pulls catalog runtime that the cold capability catalog must not load.
const PROVIDER_ID = "vercel-ai-gateway";
const DEFAULT_MODEL = "openai/tts-1";

function readSpeechConfig(raw: SpeechProviderConfig) {
  return {
    apiKey: normalizeOptionalString(raw.apiKey),
    model: normalizeOptionalString(raw.model ?? raw.modelId) ?? DEFAULT_MODEL,
    // Unset voice lets each upstream use its AI SDK default (OpenAI: alloy).
    voice: [raw.speakerVoice, raw.speakerVoiceId, raw.voice, raw.voiceId]
      .map(normalizeOptionalString)
      .find(Boolean),
    speed: asFiniteNumber(raw.speed),
    language: normalizeOptionalString(raw.language),
    instructions: normalizeOptionalString(raw.instructions),
    // Passed through as the AI SDK outputFormat; valid values depend on the upstream provider.
    responseFormat: normalizeOptionalString(raw.responseFormat)?.toLowerCase(),
  };
}

// Headerless sample formats (OpenAI `pcm`, ElevenLabs `pcm_24000`, ...) carry no encoding
// metadata, so neither MIME sniffing nor the shared ffmpeg transcoder can decode them.
function isRawPcmFormat(format: string | undefined): boolean {
  return format !== undefined && /^(?:pcm|raw|s16le|ulaw|alaw)(?:[_-]|$)/.test(format);
}

// AI Gateway's native speech endpoint, as called by @ai-sdk/gateway's GatewaySpeechModel.
// The Gateway has no OpenAI-style /v1/audio/speech route.
export function buildVercelAiGatewaySpeechProvider(
  context: Pick<
    PluginCapabilityCatalogHostContext,
    | "isProviderAuthProfileConfigured"
    | "isProviderAuthProfileConfiguredAsync"
    | "resolveApiKeyForProvider"
  >,
): SpeechProviderPlugin {
  // Readiness mirrors synthesis: a TTS key, else the chat credentials (env, config, auth profile).
  const hasDirectApiKey = ({
    cfg,
    providerConfig,
  }: Parameters<SpeechProviderPlugin["isConfigured"]>[0]) =>
    Boolean(
      readSpeechConfig(providerConfig).apiKey ??
      normalizeOptionalString(process.env.AI_GATEWAY_API_KEY) ??
      cfg?.models?.providers?.[PROVIDER_ID]?.apiKey,
    );
  return {
    id: PROVIDER_ID,
    label: "Vercel AI Gateway",
    autoSelectOrder: 35,
    defaultModel: DEFAULT_MODEL,
    models: [DEFAULT_MODEL, "openai/tts-1-hd"],
    resolveConfig: ({ rawConfig }) => {
      const raw = asOptionalRecord(asOptionalRecord(rawConfig.providers)?.[PROVIDER_ID]) ?? {};
      return {
        ...readSpeechConfig(raw),
        apiKey: normalizeResolvedSecretInputString({
          value: raw.apiKey,
          path: `tts.providers.${PROVIDER_ID}.apiKey`,
        }),
      };
    },
    parseDirectiveToken: createSpeechDirectiveParser({
      voice: ["allowVoice", ["voice", "voice_id", "voiceid"]],
      model: ["allowModelId", ["model", "model_id", "modelid"]],
    }),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured: (ctx) =>
      hasDirectApiKey(ctx) ||
      context.isProviderAuthProfileConfigured({ provider: PROVIDER_ID, cfg: ctx.cfg }),
    isConfiguredAsync: async (ctx) =>
      hasDirectApiKey(ctx) ||
      (await context.isProviderAuthProfileConfiguredAsync({ provider: PROVIDER_ID, cfg: ctx.cfg })),
    synthesize: async (req) => {
      const config = readSpeechConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const model = normalizeOptionalString(overrides.model ?? overrides.modelId) ?? config.model;
      const voice = normalizeOptionalString(overrides.voice ?? overrides.voiceId) ?? config.voice;
      const speed = asFiniteNumber(overrides.speed) ?? config.speed;
      const apiKey =
        config.apiKey ??
        (await context.resolveApiKeyForProvider({ provider: PROVIDER_ID, cfg: req.cfg })).apiKey;
      if (!apiKey) {
        throw new Error("Vercel AI Gateway API key missing for TTS");
      }
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const { postJsonResponse, resolveProviderHttpRequestConfig } =
        await import("openclaw/plugin-sdk/provider-http");
      const { canonicalizeBase64, detectMime, extensionForMime, transcodeAudioBufferToOpus } =
        await import("openclaw/plugin-sdk/media-runtime");
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          defaultBaseUrl: "https://ai-gateway.vercel.sh",
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "ai-gateway-protocol-version": "0.0.1",
            "ai-gateway-auth-method": "api-key",
            "ai-speech-model-specification-version": "4",
            "ai-model-id": model,
          },
          provider: PROVIDER_ID,
          api: "vercel-ai-gateway-speech",
          capability: "audio",
          transport: "http",
        });
      const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");
      // Voice notes need a self-describing container to transcode. Drop a raw PCM request
      // there so the upstream returns its default container (MP3 for OpenAI) instead.
      const requestFormat =
        req.target === "voice-note" && isRawPcmFormat(config.responseFormat)
          ? undefined
          : config.responseFormat;
      const payload = await postJsonResponse({
        url: `${baseUrl}/v4/ai/speech-model`,
        headers,
        body: {
          text: req.text,
          ...(voice ? { voice } : {}),
          ...(requestFormat ? { outputFormat: requestFormat } : {}),
          ...(config.instructions ? { instructions: config.instructions } : {}),
          ...(speed == null ? {} : { speed }),
          ...(config.language ? { language: config.language } : {}),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        auditContext: "vercel-ai-gateway tts",
        errorLabel: "Vercel AI Gateway speech synthesis failed",
        responseLabel: "vercel-ai-gateway.tts",
        // Base64 inflates audio by 4/3; leave room for the JSON envelope.
        readOptions: { maxBytes: Math.ceil(maxBytes / 3) * 4 + 64 * 1024 },
        objectResponse: true,
      });
      const audio =
        typeof payload.audio === "string" ? canonicalizeBase64(payload.audio) : undefined;
      if (!audio) {
        throw new Error("Vercel AI Gateway speech response has missing or malformed base64 audio");
      }
      const audioBuffer = Buffer.from(audio, "base64");
      // The response carries no media type; sniff it like the AI SDK does.
      const mime = await detectMime({ buffer: audioBuffer });
      const fileExtension = extensionForMime(mime) ?? `.${requestFormat ?? "mp3"}`;
      const voiceCompatible = mime === "audio/ogg" || mime === "audio/opus";
      if (req.target === "voice-note" && !voiceCompatible) {
        // Upstream formats vary by model, so convert instead of requesting a codec it may reject.
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer,
            inputExtension: fileExtension.slice(1),
            tempPrefix: "tts-vercel-ai-gateway-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer,
        outputFormat: fileExtension.slice(1),
        fileExtension,
        voiceCompatible: req.target === "voice-note" && voiceCompatible,
      };
    },
  };
}
