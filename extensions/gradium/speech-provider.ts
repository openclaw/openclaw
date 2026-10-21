import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech";
import {
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_GRADIUM_VOICE_ID,
  GRADIUM_API_HOSTNAME,
  GRADIUM_VOICES,
  normalizeGradiumBaseUrl,
} from "./shared.js";

function normalizeGradiumProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.gradium);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.gradium.apiKey",
    }),
    baseUrl: normalizeGradiumBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_GRADIUM_VOICE_ID,
  };
}

function readGradiumProviderConfig(config: SpeechProviderConfig) {
  return normalizeGradiumProviderConfig({
    providers: { gradium: { ...config, apiKey: trimToUndefined(config.apiKey) } },
  });
}

function resolveGradiumApiKey(configApiKey: unknown): string | undefined {
  return resolveSpeechProviderApiKey(trimToUndefined(configApiKey), process.env.GRADIUM_API_KEY);
}

async function synthesizeGradium(
  req: SpeechSynthesisRequest | SpeechTelephonySynthesisRequest,
  outputFormat: "wav" | "opus" | "ulaw_8000",
): Promise<Buffer> {
  const config = readGradiumProviderConfig(req.providerConfig);
  const apiKey = resolveGradiumApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Gradium API key missing");
  }
  const { resolveGeneratedMediaMaxBytes } =
    await import("openclaw/plugin-sdk/media-generation-runtime");
  const text = req.text;
  const voiceId = trimToUndefined(req.providerOverrides?.voiceId) ?? config.voiceId;
  const timeoutMs = req.timeoutMs;
  const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");
  const url = `${config.baseUrl}/api/post/speech/tts`;
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        only_audio: true,
        output_format: outputFormat,
        json_config: JSON.stringify({ padding_bonus: 0 }),
      }),
    },
    timeoutMs,
    requireHttps: true,
    // Keep the transport boundary independent from config normalization so a
    // future validator relaxation cannot silently widen credential egress.
    policy: { hostnameAllowlist: [GRADIUM_API_HOSTNAME] },
    auditContext: "gradium.tts",
  });

  try {
    await assertOkOrThrowProviderError(response, "Gradium API error", {
      requestHeaders: { "x-api-key": apiKey },
    });

    return await readProviderBinaryResponse(response, "Gradium API error", "audio", {
      maxBytes,
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`Gradium TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}

function isGradiumProviderConfigured(config: SpeechProviderConfig): boolean {
  const apiKey = resolveGradiumApiKey(config.apiKey);
  if (!apiKey) {
    return false;
  }
  try {
    normalizeGradiumBaseUrl(trimToUndefined(config.baseUrl));
    return true;
  } catch {
    // Provider selection is a predicate; synthesis reports the precise URL error.
    return false;
  }
}

const parseDirectiveToken = createSpeechDirectiveParser({
  voiceId: ["allowVoice", ["voice", "voice_id", "voiceid", "gradium_voice", "gradiumvoice"]],
});

export function buildGradiumSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) =>
    isGradiumProviderConfigured(providerConfig);
  return {
    id: "gradium",
    label: "Gradium",
    autoSelectOrder: 30,
    voices: GRADIUM_VOICES.map((v) => v.id),
    resolveConfig: ({ rawConfig }) => normalizeGradiumProviderConfig(rawConfig),
    parseDirectiveToken,
    listVoices: async () => GRADIUM_VOICES.map((v) => ({ id: v.id, name: v.name })),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const wantsVoiceNote = req.target === "voice-note";
      const outputFormat = wantsVoiceNote ? "opus" : "wav";
      const audioBuffer = await synthesizeGradium(req, outputFormat);
      return {
        audioBuffer,
        outputFormat,
        fileExtension: wantsVoiceNote ? ".opus" : ".wav",
        voiceCompatible: wantsVoiceNote,
      };
    },
    synthesizeTelephony: async (req) => ({
      audioBuffer: await synthesizeGradium(req, "ulaw_8000"),
      outputFormat: "ulaw_8000",
      sampleRate: 8_000,
    }),
  };
}
