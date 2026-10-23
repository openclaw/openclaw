import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";
const MINIMAX_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;
const MINIMAX_TTS_VOICES = [
  "English_expressive_narrator",
  "Chinese (Mandarin)_Warm_Girl",
  "Chinese (Mandarin)_Lively_Girl",
  "Chinese (Mandarin)_Gentle_Boy",
  "Chinese (Mandarin)_Steady_Boy",
] as const;

function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed
    ? trimmed.replace(/\/+$/, "").replace(/\/(?:anthropic|v1)$/i, "")
    : DEFAULT_MINIMAX_TTS_BASE_URL;
}

const MINIMAX_PORTAL_PROVIDER_ID = "minimax-portal";
const MINIMAX_TOKEN_PLAN_ENV_VARS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
] as const;

type MinimaxTtsProviderOverrides = Partial<
  Pick<
    ReturnType<typeof normalizeMinimaxProviderConfig>,
    "model" | "voiceId" | "speed" | "vol" | "pitch"
  >
>;

function resolveConfiguredPortalTtsBaseUrl(cfg: OpenClawConfig | undefined): string | undefined {
  const portalBaseUrl = trimToUndefined(
    cfg?.models?.providers?.[MINIMAX_PORTAL_PROVIDER_ID]?.baseUrl,
  );
  return portalBaseUrl ? normalizeMinimaxTtsBaseUrl(portalBaseUrl) : undefined;
}

function resolveMinimaxDirectTtsApiKey(configApiKey?: string): string | undefined {
  return resolveSpeechProviderApiKey(
    configApiKey,
    ...MINIMAX_TOKEN_PLAN_ENV_VARS.map((envVar) => process.env[envVar]),
    process.env.MINIMAX_API_KEY,
  );
}

function normalizeMinimaxProviderConfig(rawConfig: Record<string, unknown>, cfg?: OpenClawConfig) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.minimax);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.minimax.apiKey",
    }),
    baseUrl: normalizeMinimaxTtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ??
        trimToUndefined(process.env.MINIMAX_API_HOST) ??
        resolveConfiguredPortalTtsBaseUrl(cfg) ??
        DEFAULT_MINIMAX_TTS_BASE_URL,
    ),
    model:
      trimToUndefined(raw?.model) ??
      trimToUndefined(process.env.MINIMAX_TTS_MODEL) ??
      "speech-2.8-hd",
    voiceId:
      trimToUndefined(raw?.voiceId) ??
      trimToUndefined(process.env.MINIMAX_TTS_VOICE_ID) ??
      "English_expressive_narrator",
    speed: normalizeMinimaxSpeed(raw?.speed),
    vol: normalizeMinimaxVolume(raw?.vol),
    pitch: normalizeMinimaxPitch(raw?.pitch),
  };
}

function normalizeMinimaxSpeed(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.5, max: 2 });
}

function normalizeMinimaxVolume(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0, max: 10, minExclusive: true });
}

function normalizeMinimaxPitch(value: unknown): number | undefined {
  const pitch = asFiniteNumberInRange(value, { min: -12, max: 12 });
  return pitch !== undefined ? Math.trunc(pitch) : undefined;
}

function readMinimaxProviderConfig(config: SpeechProviderConfig, cfg?: OpenClawConfig) {
  return normalizeMinimaxProviderConfig(
    { providers: { minimax: { ...config, apiKey: trimToUndefined(config.apiKey) } } },
    cfg,
  );
}

function readMinimaxOverrides(
  overrides: SpeechProviderOverrides | undefined,
): MinimaxTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  const normalized: MinimaxTtsProviderOverrides = {
    model: trimToUndefined(overrides.model),
    voiceId: trimToUndefined(overrides.voiceId),
    speed: normalizeMinimaxSpeed(overrides.speed),
    vol: normalizeMinimaxVolume(overrides.vol),
    pitch: normalizeMinimaxPitch(overrides.pitch),
  };
  for (const key of ["model", "voiceId", "speed", "vol", "pitch"] as const) {
    if (normalized[key] === undefined) {
      delete normalized[key];
    }
  }
  return normalized;
}

const parseDirectiveToken = createSpeechDirectiveParser({
  voiceId: ["allowVoice", ["voice", "voiceid", "voice_id", "minimax_voice", "minimaxvoice"]],
  model: ["allowModelId", ["model", "minimax_model", "minimaxmodel"]],
  speed: [
    "allowVoiceSettings",
    ["speed"],
    {
      number: {
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid MiniMax speed "${value}" (0.5-2.0)`,
      },
    },
  ],
  vol: [
    "allowVoiceSettings",
    ["vol", "volume"],
    {
      number: {
        range: { min: 0, minExclusive: true, max: 10 },
        warning: (value) =>
          `invalid MiniMax volume "${value}" (must be greater than 0 and at most 10)`,
      },
    },
  ],
  pitch: [
    "allowVoiceSettings",
    ["pitch"],
    {
      number: {
        range: { min: -12, max: 12 },
        warning: (value) => `invalid MiniMax pitch "${value}" (-12 to 12)`,
      },
    },
  ],
});

export function buildMinimaxSpeechProvider({
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
}: Pick<
  PluginCapabilityCatalogHostContext,
  "isProviderAuthProfileConfigured" | "isProviderAuthProfileConfiguredAsync"
>): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    autoSelectOrder: 40,
    defaultModel: MINIMAX_TTS_MODELS[0],
    models: MINIMAX_TTS_MODELS,
    voices: MINIMAX_TTS_VOICES,
    resolveConfig: ({ rawConfig, cfg }) => normalizeMinimaxProviderConfig(rawConfig, cfg),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMinimaxProviderConfig(baseTtsConfig);
      const talkBaseUrl = trimToUndefined(talkProviderConfig.baseUrl);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.minimax.apiKey",
              }),
            }),
        ...(talkBaseUrl ? { baseUrl: normalizeMinimaxTtsBaseUrl(talkBaseUrl) } : {}),
        ...readMinimaxOverrides({ ...talkProviderConfig, model: talkProviderConfig.modelId }),
      };
    },
    resolveTalkOverrides: ({ params }) =>
      readMinimaxOverrides({ ...params, model: params.modelId }),
    listVoices: async () => MINIMAX_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        resolveMinimaxDirectTtsApiKey(readMinimaxProviderConfig(providerConfig, cfg).apiKey) ||
        isProviderAuthProfileConfigured({ cfg, provider: MINIMAX_PORTAL_PROVIDER_ID }),
      ),
    isConfiguredAsync: async ({ cfg, providerConfig }) =>
      Boolean(
        resolveMinimaxDirectTtsApiKey(readMinimaxProviderConfig(providerConfig, cfg).apiKey) ||
        (await isProviderAuthProfileConfiguredAsync({ cfg, provider: MINIMAX_PORTAL_PROVIDER_ID })),
      ),
    synthesize: async (req) => {
      const config = readMinimaxProviderConfig(req.providerConfig, req.cfg);
      const overrides = readMinimaxOverrides(req.providerOverrides);
      const { resolveProviderAuthProfileApiKey } =
        await import("openclaw/plugin-sdk/provider-auth");
      const apiKey = resolveSpeechProviderApiKey(
        config.apiKey,
        await resolveProviderAuthProfileApiKey({
          cfg: req.cfg,
          provider: MINIMAX_PORTAL_PROVIDER_ID,
        }),
        resolveMinimaxDirectTtsApiKey(),
      );
      if (!apiKey) {
        throw new Error("MiniMax TTS auth missing");
      }
      const safeTimeoutMs = resolveTimerTimeoutMs(req.timeoutMs, 1);
      const { assertOkOrThrowProviderError, readProviderJsonObjectResponse } =
        await import("openclaw/plugin-sdk/provider-http");
      const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
        await import("openclaw/plugin-sdk/ssrf-runtime");
      const { assertMinimaxBaseResp, normalizeMinimaxHexAudio } =
        await import("./media-provider-runtime.js");
      let audioBuffer: Buffer;
      const { response, release } = await fetchWithSsrFGuard({
        url: `${config.baseUrl}/v1/t2a_v2`,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: overrides.model ?? config.model,
            text: req.text,
            stream: false,
            output_format: "hex",
            voice_setting: {
              voice_id: overrides.voiceId ?? config.voiceId,
              speed: overrides.speed ?? config.speed ?? 1,
              vol: overrides.vol ?? config.vol ?? 1,
              pitch: overrides.pitch ?? config.pitch ?? 0,
            },
            audio_setting: { format: "mp3", sample_rate: 32000 },
          }),
        },
        timeoutMs: safeTimeoutMs,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(config.baseUrl),
        auditContext: "minimax.tts",
      });
      try {
        await assertOkOrThrowProviderError(response, "MiniMax TTS API error");
        const body = await readProviderJsonObjectResponse(response, "minimax.tts");
        assertMinimaxBaseResp(body.base_resp, "MiniMax TTS API error");
        const hexAudio = readStringField(asOptionalRecord(body.data), "audio");
        if (!hexAudio) {
          throw new Error("MiniMax TTS API returned no audio data");
        }
        audioBuffer = Buffer.from(normalizeMinimaxHexAudio(hexAudio, "MiniMax TTS API"), "hex");
      } finally {
        await release();
      }
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        const opusBuffer = await transcodeAudioBufferToOpus({
          audioBuffer,
          inputExtension: "mp3",
          tempPrefix: "tts-minimax-",
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
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
