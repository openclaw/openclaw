import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_XIAOMI_TTS_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_XIAOMI_TTS_MODEL = "mimo-v2.5-tts";
const DEFAULT_XIAOMI_TTS_VOICE = "mimo_default";
const DEFAULT_XIAOMI_TTS_FORMAT = "mp3";
const XIAOMI_TTS_VOICE_DESIGN_MODEL = "mimo-v2.5-tts-voicedesign";
const DEFAULT_XIAOMI_TTS_VOICE_DESIGN_STYLE =
  "Warm, natural, and friendly voice with clear pronunciation and conversational pacing.";

const XIAOMI_TTS_MODELS = ["mimo-v2.5-tts", XIAOMI_TTS_VOICE_DESIGN_MODEL] as const;

const XIAOMI_TTS_VOICES = [
  "mimo_default",
  "default_zh",
  "default_en",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;

const XIAOMI_TTS_FORMATS = ["mp3", "wav"] as const;

type XiaomiTtsFormat = (typeof XIAOMI_TTS_FORMATS)[number];

function normalizeXiaomiTtsBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_XIAOMI_TTS_BASE_URL).replace(/\/+$/, "");
}

function normalizeXiaomiTtsFormat(value: unknown): XiaomiTtsFormat | undefined {
  const normalized = trimToUndefined(value)?.toLowerCase();
  return XIAOMI_TTS_FORMATS.find((format) => format === normalized);
}

function resolveXiaomiTtsConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(rawConfig.providers);
  return (
    asOptionalRecord(providers?.xiaomi) ??
    asOptionalRecord(providers?.mimo) ??
    asOptionalRecord(rawConfig.xiaomi)
  );
}

function normalizeXiaomiTtsProviderConfig(rawConfig: Record<string, unknown>) {
  const raw = resolveXiaomiTtsConfigRecord(rawConfig);
  const options = readXiaomiTtsOptions(raw);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.xiaomi.apiKey",
    }),
    baseUrl: normalizeXiaomiTtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ?? trimToUndefined(process.env.XIAOMI_BASE_URL),
    ),
    model:
      options.model ?? trimToUndefined(process.env.XIAOMI_TTS_MODEL) ?? DEFAULT_XIAOMI_TTS_MODEL,
    voice:
      options.voice ?? trimToUndefined(process.env.XIAOMI_TTS_VOICE) ?? DEFAULT_XIAOMI_TTS_VOICE,
    format:
      options.format ??
      normalizeXiaomiTtsFormat(process.env.XIAOMI_TTS_FORMAT) ??
      DEFAULT_XIAOMI_TTS_FORMAT,
    style: options.style,
  };
}

function resolveXiaomiTtsProviderConfig(config: SpeechProviderConfig) {
  const providerConfig = normalizeXiaomiTtsProviderConfig({ xiaomi: config });
  const resolvedKey = resolveSpeechProviderApiKey(
    providerConfig.apiKey,
    process.env.XIAOMI_API_KEY,
  );
  return {
    ...providerConfig,
    apiKey: resolvedKey,
  };
}

function readXiaomiTtsOptions(options: SpeechProviderOverrides | undefined) {
  return {
    model: trimToUndefined(options?.model) ?? trimToUndefined(options?.modelId),
    voice:
      trimToUndefined(options?.speakerVoice) ??
      trimToUndefined(options?.speakerVoiceId) ??
      trimToUndefined(options?.voice) ??
      trimToUndefined(options?.voiceId),
    format: normalizeXiaomiTtsFormat(options?.format),
    style: trimToUndefined(options?.style),
  };
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
): SpeechDirectiveTokenParseResult {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "mimo_voice":
    case "xiaomi_voice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "model":
    case "mimo_model":
    case "xiaomi_model":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    case "style":
    case "mimo_style":
    case "xiaomi_style":
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      return { handled: true, overrides: { style: ctx.value } };
    case "format":
    case "responseformat":
    case "response_format": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const format = normalizeXiaomiTtsFormat(ctx.value);
      if (!format) {
        return { handled: true, warnings: [`invalid Xiaomi TTS format "${ctx.value}"`] };
      }
      return { handled: true, overrides: { format } };
    }
    default:
      return { handled: false };
  }
}

async function xiaomiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  format: XiaomiTtsFormat;
  style?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voice, format, style, timeoutMs } = params;
  const requestTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const { canonicalizeBase64 } = await import("openclaw/plugin-sdk/blob-runtime");
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const voiceDesign = model === XIAOMI_TTS_VOICE_DESIGN_MODEL;
  const resolvedStyle =
    trimToUndefined(style) ?? (voiceDesign ? DEFAULT_XIAOMI_TTS_VOICE_DESIGN_STYLE : undefined);

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(resolvedStyle ? [{ role: "user", content: resolvedStyle }] : []),
            { role: "assistant", content: text },
          ],
          audio: voiceDesign ? { format } : { format, voice },
        }),
        signal: controller.signal,
      },
      timeoutMs: requestTimeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
      auditContext: "xiaomi.tts",
    });
    try {
      await assertOkOrThrowProviderError(response, "Xiaomi TTS API error");
      const body = await readProviderJsonResponse<unknown>(response, "Xiaomi TTS API");
      const root = asOptionalRecord(body);
      const choices = Array.isArray(root?.choices) ? root.choices : [];
      const firstChoice = asOptionalRecord(choices[0]);
      const message = asOptionalRecord(firstChoice?.message);
      const audio = asOptionalRecord(message?.audio);
      const audioData = trimToUndefined(audio?.data);
      if (!audioData) {
        throw new Error("Xiaomi TTS API returned no audio data");
      }
      const canonicalAudio = canonicalizeBase64(audioData);
      if (!canonicalAudio) {
        throw new Error("Xiaomi TTS API returned malformed base64 audio data");
      }
      return Buffer.from(canonicalAudio, "base64");
    } finally {
      await release();
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function buildXiaomiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    aliases: ["mimo"],
    autoSelectOrder: 45,
    defaultModel: DEFAULT_XIAOMI_TTS_MODEL,
    models: XIAOMI_TTS_MODELS,
    voices: XIAOMI_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeXiaomiTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    listVoices: async () => XIAOMI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveXiaomiTtsProviderConfig(providerConfig).apiKey),
    synthesize: async (req) => {
      const config = resolveXiaomiTtsProviderConfig(req.providerConfig);
      const overrides = readXiaomiTtsOptions(req.providerOverrides);
      if (!config.apiKey) {
        throw new Error("Xiaomi API key missing");
      }
      const outputFormat = overrides.format ?? config.format;
      const audioBuffer = await xiaomiTTS({
        text: req.text,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voice: overrides.voice ?? config.voice,
        format: outputFormat,
        style: overrides.style ?? config.style,
        timeoutMs: req.timeoutMs,
      });
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        const opusBuffer = await transcodeAudioBufferToOpus({
          audioBuffer,
          inputExtension: outputFormat,
          tempPrefix: "tts-xiaomi-",
          timeoutMs: req.timeoutMs,
        });
        return {
          audioBuffer: opusBuffer,
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer,
        outputFormat,
        fileExtension: `.${outputFormat}`,
        voiceCompatible: false,
      };
    },
  };
}
