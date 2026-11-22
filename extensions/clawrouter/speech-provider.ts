import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderPlugin, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import {
  buildGradiumSpeechRequestBody,
  buildOpenAiSpeechRequestBody,
  createSpeechDirectiveParser,
  DEFAULT_GRADIUM_VOICE_ID,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";

const MODEL = "openai/tts-1";
const VOICES = OPENAI_TTS_VOICES;
const GRADIUM_FORMATS = new Set(["wav", "opus"]);
const FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

function readVoice(raw: Record<string, unknown>) {
  return [raw.speakerVoice, raw.speakerVoiceId, raw.voice, raw.voiceId]
    .map(normalizeOptionalString)
    .find(Boolean);
}

function readConfig(raw: Record<string, unknown>, path: string) {
  const upstreamProvider = normalizeOptionalString(raw.upstreamProvider) ?? "openai";
  if (upstreamProvider !== "openai" && upstreamProvider !== "gradium") {
    throw new Error("Unsupported ClawRouter speech upstreamProvider");
  }
  const responseFormat = normalizeOptionalString(raw.responseFormat)?.toLowerCase();
  if (
    responseFormat &&
    !(upstreamProvider === "gradium" ? GRADIUM_FORMATS : FORMATS).has(responseFormat)
  ) {
    throw new Error("Invalid ClawRouter speech responseFormat");
  }
  return {
    upstreamProvider,
    apiKey: normalizeResolvedSecretInputString({ value: raw.apiKey, path: path + ".apiKey" }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model:
      normalizeOptionalString(raw.model ?? raw.modelId) ??
      (upstreamProvider === "gradium" ? undefined : MODEL),
    voice: readVoice(raw) ?? (upstreamProvider === "gradium" ? DEFAULT_GRADIUM_VOICE_ID : "alloy"),
    speed: raw.speed,
    instructions: normalizeOptionalString(raw.instructions),
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
    const { resolveClawRouterCapabilityHttpContext } = await import("./capability-offers.js");
    return resolveClawRouterCapabilityHttpContext(
      {
        ...cfg,
        models: {
          ...cfg.models,
          providers: {
            ...cfg.models?.providers,
            clawrouter: {
              ...cfg.models?.providers?.clawrouter,
              baseUrl,
              models: cfg.models?.providers?.clawrouter?.models ?? [],
            },
          },
        },
      },
      auth.apiKey,
      "audio",
    );
  }

  async function synthesize(req: SpeechSynthesisRequest, telephony = false) {
    const {
      createProviderOperationDeadline,
      createProviderOperationTimeoutResolver,
      assertOkOrThrowProviderError,
      readProviderBinaryResponse,
    } = await import("openclaw/plugin-sdk/provider-http");
    const remaining = createProviderOperationTimeoutResolver({
      deadline: createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "ClawRouter speech",
      }),
      defaultTimeoutMs: req.timeoutMs,
    });
    const base = readConfig(req.providerConfig, "tts.providers.clawrouter");
    const overrides = req.providerOverrides ?? {};
    const config = {
      ...base,
      model: normalizeOptionalString(overrides.model ?? overrides.modelId) ?? base.model,
      voice: readVoice(overrides) ?? base.voice,
      speed: overrides.speed ?? base.speed,
    };
    const gradium = config.upstreamProvider === "gradium";
    if (gradium && telephony) {
      throw new Error("ClawRouter Gradium telephony output is not qualified");
    }
    const upstream = config.model?.startsWith("openai/")
      ? config.model.slice("openai/".length)
      : "";
    if (gradium && (config.model || config.speed !== undefined || config.instructions)) {
      throw new Error(
        "ClawRouter Gradium speech is model-less and does not support model, speed, or instructions overrides",
      );
    }
    if (!gradium && !OPENAI_TTS_MODELS.some((model) => model === upstream)) {
      throw new Error("ClawRouter speech requires a qualified OpenAI speech model");
    }
    if (!gradium && !VOICES.some((voice) => voice === config.voice)) {
      throw new Error("Invalid ClawRouter OpenAI speech voice");
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
    const { mergeSsrFPolicies } = await import("openclaw/plugin-sdk/ssrf-runtime");
    const { resolveGeneratedMediaMaxBytes } =
      await import("openclaw/plugin-sdk/media-generation-runtime");
    const http = await resolveAuth(req.cfg, {
      ...req.providerConfig,
      model: config.model,
    });
    const { fetchClawRouterCapabilityOffers } = await import("./capability-offers.js");
    if (gradium) {
      http.headers.delete("x-api-key");
    }
    const offers = await fetchClawRouterCapabilityOffers({
      context: http,
      timeoutMs: remaining,
      requireFreshProxyCatalog: gradium,
    });
    const offer = gradium
      ? offers.find(
          (candidate) =>
            candidate.providerId === "gradium" &&
            candidate.endpoint === "speech" &&
            candidate.path === "/api/post/speech/tts" &&
            candidate.model === undefined &&
            candidate.methods.includes("POST") &&
            candidate.requestFormat === "gradium.speech" &&
            candidate.responseFormat === "audio.binary" &&
            (candidate.routeKind === "manifest" ||
              (candidate.routeKind === "native" &&
                candidate.url ===
                  http.baseUrl.replace(/\/v1\/?$/u, "") +
                    "/v1/native/gradium/api/post/speech/tts")),
        )
      : offers.find(
          (candidate) =>
            candidate.providerId === "openai" &&
            candidate.model !== undefined &&
            candidate.model.id === config.model &&
            candidate.model.upstream === upstream &&
            Array.isArray(candidate.model.capabilities) &&
            candidate.model.capabilities.includes("audio.speech") &&
            candidate.methods.includes("POST") &&
            candidate.requestFormat === "openai.audio_speech" &&
            candidate.responseFormat === "audio.binary",
        );
    if (!offer) {
      throw new Error("Selected ClawRouter speech model has no eligible supported offer");
    }
    const headers = new Headers(http.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "audio/*, application/octet-stream");
    const responseFormat = telephony
      ? "pcm"
      : (config.responseFormat ?? (req.target === "voice-note" ? "opus" : gradium ? "wav" : "mp3"));
    const body = gradium
      ? buildGradiumSpeechRequestBody({
          text: req.text,
          voiceId: config.voice,
          outputFormat: responseFormat === "opus" ? "opus" : "wav",
        })
      : buildOpenAiSpeechRequestBody({
          model: offer.routeKind === "unified" ? config.model! : upstream,
          text: req.text,
          voice: config.voice,
          responseFormat,
          speed: typeof config.speed === "number" ? config.speed : undefined,
          instructions: upstream.startsWith("gpt-4o-mini-tts") ? config.instructions : undefined,
        });
    const { response, release } = await context.fetchWithSsrFGuard({
      url: offer.url,
      maxRedirects: 0,
      timeoutMs: remaining(),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(offer.routeKind === "manifest" ? { body } : body),
      },
      policy: mergeSsrFPolicies(
        http.ssrfPolicy,
        http.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: http.dispatcherPolicy,
      auditContext: "clawrouter.speech",
    });
    try {
      await assertOkOrThrowProviderError(response, "ClawRouter speech error", {
        requestHeaders: headers,
      });
      if (gradium) {
        const mime = response.headers.get("content-type")?.trim().toLowerCase();
        const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
        if (
          response.status !== 200 ||
          response.redirected ||
          response.headers.has("content-range") ||
          (encoding !== undefined && encoding !== "identity") ||
          mime !== (responseFormat === "wav" ? "audio/wav" : "audio/ogg")
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(
            "ClawRouter Gradium speech response does not match the requested audio format",
          );
        }
      }
      const audioBuffer = await readProviderBinaryResponse(
        response,
        "ClawRouter speech error",
        "audio",
        {
          maxBytes: Math.min(
            gradium ? 16 * 1024 * 1024 : Infinity,
            resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
          ),
          timeoutMs: remaining,
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
      const upstreamProvider = normalizeOptionalString(talkProviderConfig.upstreamProvider);
      const inherited =
        upstreamProvider && upstreamProvider !== base.upstreamProvider
          ? readConfig(
              {
                upstreamProvider,
                apiKey: base.apiKey,
                baseUrl: base.baseUrl,
                profileId: base.profileId,
              },
              "talk.providers.clawrouter",
            )
          : base;
      return readConfig(
        {
          ...inherited,
          ...talkProviderConfig,
          model: talkProviderConfig.modelId ?? talkProviderConfig.model ?? inherited.model,
          voice: readVoice(talkProviderConfig) ?? inherited.voice,
        },
        "talk.providers.clawrouter",
      );
    },
    resolveTalkOverrides: ({ params }) => ({
      model: params.modelId,
      voice: params.voiceId,
      speed: params.speed,
    }),
    listVoices: async ({ providerConfig, cfg }) => {
      const config = providerConfig
        ? readConfig(providerConfig, "tts.providers.clawrouter")
        : ttsConfig(asOptionalRecord(cfg?.tts) ?? {});
      return config.upstreamProvider === "gradium"
        ? []
        : VOICES.map((voice) => ({ id: voice, name: voice }));
    },
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
    synthesizeTelephony: async (req) => {
      const result = await synthesize({ ...req, target: "telephony" }, true);
      return { ...result, sampleRate: 24_000 };
    },
  };
}
