import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderPlugin, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { createSpeechDirectiveParser } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";

const MODEL = "openai/tts-1";
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

function readVoice(raw: Record<string, unknown>) {
  return [raw.speakerVoice, raw.speakerVoiceId, raw.voice, raw.voiceId]
    .map(normalizeOptionalString)
    .find(Boolean);
}

function readConfig(raw: Record<string, unknown>, path: string) {
  const responseFormat = normalizeOptionalString(raw.responseFormat)?.toLowerCase();
  if (responseFormat && !FORMATS.has(responseFormat)) {
    throw new Error("Invalid ClawRouter speech responseFormat");
  }
  return {
    apiKey: normalizeResolvedSecretInputString({ value: raw.apiKey, path: path + ".apiKey" }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model ?? raw.modelId) ?? MODEL,
    voice: readVoice(raw) ?? "alloy",
    speed: raw.speed,
    responseFormat,
    // An explicit profile is terminal; it must not fall back to an env or inline key.
    profileId: normalizeOptionalString(raw.profileId),
  };
}

function ttsConfig(raw: Record<string, unknown>) {
  return readConfig(
    asOptionalRecord(asOptionalRecord(raw.providers)?.clawrouter) ?? {},
    "tts.providers.clawrouter",
  );
}

export function buildClawRouterSpeechProvider(
  context: Pick<PluginCapabilityCatalogContext, "resolveApiKeyForProvider" | "fetchWithSsrFGuard">,
): SpeechProviderPlugin {
  async function resolveAuth(cfg: SpeechSynthesisRequest["cfg"], raw: Record<string, unknown>) {
    const config = readConfig(raw, "tts.providers.clawrouter");
    const baseUrl = normalizeClawRouterApiBaseUrl(
      config.baseUrl ?? cfg.models?.providers?.clawrouter?.baseUrl,
    );
    let store: AuthProfileStore | undefined;
    if (config.profileId) {
      const { ensureAuthProfileStoreAsync, listProfilesForProvider } =
        await import("openclaw/plugin-sdk/provider-auth");
      const { resolveDefaultAgentDir } =
        await import("openclaw/plugin-sdk/agent-harness-registration");
      store = await ensureAuthProfileStoreAsync(resolveDefaultAgentDir(cfg), {
        allowKeychainPrompt: false,
      });
      // The generic explicit-profile resolver locks identity, not provider ownership.
      if (!listProfilesForProvider(store, "clawrouter").includes(config.profileId)) {
        throw new Error("Selected speech auth profile is unavailable for ClawRouter");
      }
    }
    const auth = await context.resolveApiKeyForProvider({
      provider: "clawrouter",
      ...(store ? { store } : {}),
      cfg:
        config.apiKey && !config.profileId
          ? {
              ...cfg,
              models: {
                ...cfg.models,
                providers: {
                  ...cfg.models?.providers,
                  clawrouter: {
                    ...cfg.models?.providers?.clawrouter,
                    baseUrl,
                    models: cfg.models?.providers?.clawrouter?.models ?? [],
                    apiKey: config.apiKey,
                    auth: "api-key",
                  },
                },
              },
            }
          : cfg,
      modelId: config.model,
      modelBaseUrl: baseUrl,
      capability: "audio.speech",
      ...(config.profileId ? { profileId: config.profileId, lockedProfile: true } : {}),
    });
    if (!auth.apiKey) {
      throw new Error("Configure a ClawRouter API key for speech");
    }
    return {
      baseUrl,
      headers: {
        Authorization: "Bearer " + auth.apiKey,
        "Content-Type": "application/json",
        "X-ClawRouter-Client": "openclaw",
      },
    };
  }

  async function synthesize(req: SpeechSynthesisRequest, telephony = false) {
    const base = readConfig(req.providerConfig, "tts.providers.clawrouter");
    const overrides = req.providerOverrides ?? {};
    const config = {
      ...base,
      model: normalizeOptionalString(overrides.model ?? overrides.modelId) ?? base.model,
      voice: readVoice(overrides) ?? base.voice,
      speed: overrides.speed ?? base.speed,
    };
    if (config.model !== MODEL) {
      throw new Error("ClawRouter speech supports only openai/tts-1");
    }
    if (!VOICES.includes(config.voice)) {
      throw new Error("Invalid ClawRouter tts-1 voice");
    }
    if (
      config.speed !== undefined &&
      (typeof config.speed !== "number" ||
        !Number.isFinite(config.speed) ||
        config.speed < 0.25 ||
        config.speed > 4)
    ) {
      throw new Error("ClawRouter speech speed must be between 0.25 and 4");
    }
    if (!req.text.trim() || Array.from(req.text).length > 4096) {
      throw new Error("ClawRouter speech requires 1-4096 characters");
    }
    const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
      await import("openclaw/plugin-sdk/provider-http");
    const { ssrfPolicyFromHttpBaseUrlAllowedHostname } =
      await import("openclaw/plugin-sdk/ssrf-runtime");
    const { resolveGeneratedMediaMaxBytes } =
      await import("openclaw/plugin-sdk/media-generation-runtime");
    const { baseUrl, headers } = await resolveAuth(req.cfg, {
      ...req.providerConfig,
      model: config.model,
    });
    const responseFormat = telephony
      ? "pcm"
      : (config.responseFormat ?? (req.target === "voice-note" ? "opus" : "mp3"));
    const { response, release } = await context.fetchWithSsrFGuard({
      url: baseUrl + "/audio/speech",
      timeoutMs: req.timeoutMs,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: MODEL,
          input: req.text,
          voice: config.voice,
          response_format: responseFormat,
          ...(config.speed === undefined ? {} : { speed: config.speed }),
        }),
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
      auditContext: "clawrouter.speech",
    });
    try {
      await assertOkOrThrowProviderError(response, "ClawRouter speech error", {
        requestHeaders: headers,
      });
      const audioBuffer = await readProviderBinaryResponse(
        response,
        "ClawRouter speech error",
        "audio",
        {
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
          onOverflow: () => new Error("ClawRouter speech audio response exceeds configured limit"),
        },
      );
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: "." + responseFormat,
        voiceCompatible: responseFormat === "opus",
      };
    } finally {
      await release();
    }
  }

  return {
    id: "clawrouter",
    label: "ClawRouter",
    defaultModel: MODEL,
    models: [MODEL],
    voices: VOICES,
    resolveConfig: ({ rawConfig }) => ttsConfig(rawConfig),
    parseDirectiveToken: createSpeechDirectiveParser({
      voice: ["allowVoice", ["voice"]],
      model: ["allowModelId", ["model"]],
    }),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = ttsConfig(baseTtsConfig);
      return readConfig(
        {
          ...base,
          ...talkProviderConfig,
          model: talkProviderConfig.modelId ?? base.model,
          voice: readVoice(talkProviderConfig) ?? base.voice,
        },
        "talk.providers.clawrouter",
      );
    },
    resolveTalkOverrides: ({ params }) => ({
      model: params.modelId,
      voice: params.voiceId,
      speed: params.speed,
    }),
    listVoices: async () => VOICES.map((voice) => ({ id: voice, name: voice })),
    // Legacy synchronous callers cannot inspect the capability-scoped credential store.
    isConfigured: () => false,
    // Readiness is credential availability, not a grant: the service authorizes each POST.
    isConfiguredAsync: async ({ cfg, providerConfig }) => {
      try {
        await resolveAuth(cfg ?? {}, providerConfig);
        return true;
      } catch {
        return false;
      }
    },
    synthesize,
    synthesizeTelephony: async (req) => ({
      ...(await synthesize({ ...req, target: "telephony" }, true)),
      sampleRate: 24_000,
    }),
  };
}
