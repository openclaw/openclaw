import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { retryAsync } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleEnvApiKey } from "./gemini-auth.js";
import { readGoogleTtsSpeakers, type GoogleTtsDialogueSpeaker } from "./speech-dialogue.js";
import {
  assertSupportedGoogleTtsModel,
  DEFAULT_GOOGLE_TTS_MODEL,
  GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_SAMPLE_RATE,
  isGoogleInteractionsTtsModel,
  normalizeGooglePromptTemplate,
  normalizeGoogleTtsModel,
  normalizeGoogleTtsVoiceName,
} from "./speech-models.js";
import {
  isGoogleTtsRetryableError,
  isOpenClawGoogleAudioProfilePrompt,
  prepareGoogleInteractionsSynthesis,
  renderGoogleAudioProfilePrompt,
  synthesizeGoogleTtsPcmOnce,
  wrapPcm16MonoToWav,
} from "./speech-synthesis.js";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

type GoogleTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  speakers?: GoogleTtsDialogueSpeaker[];
  promptTemplate?: typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE;
  personaPrompt?: string;
};

type GoogleTtsProviderOverrides = Partial<
  Pick<GoogleTtsProviderConfig, "model" | "voiceName" | "audioProfile" | "speakerName">
>;

function resolveGoogleTtsApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: GoogleTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.apiKey ??
    normalizeResolvedSecretInputString({
      value: params.cfg?.models?.providers?.google?.apiKey,
      path: "models.providers.google.apiKey",
    }) ??
    resolveGoogleEnvApiKey()
  );
}

function normalizeGoogleTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): GoogleTtsProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.google) ?? asOptionalRecord(rawConfig.google);
  return {
    ...readGoogleTtsProviderConfig(raw ?? {}),
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.google.apiKey",
    }),
  };
}

function readGoogleTtsProviderConfig(config: SpeechProviderConfig): GoogleTtsProviderConfig {
  const promptTemplate = normalizeGooglePromptTemplate(config.promptTemplate);
  const personaPrompt = normalizeOptionalString(config.personaPrompt);
  const speakers = readGoogleTtsSpeakers(config.speakers);
  return {
    apiKey: normalizeOptionalString(config.apiKey),
    baseUrl: normalizeOptionalString(config.baseUrl),
    model: normalizeGoogleTtsModel(config.model),
    voiceName: normalizeGoogleTtsVoiceName(config.voiceName ?? config.voice),
    audioProfile: normalizeOptionalString(config.audioProfile),
    speakerName: normalizeOptionalString(config.speakerName),
    ...(speakers ? { speakers } : {}),
    ...(promptTemplate ? { promptTemplate } : {}),
    ...(personaPrompt ? { personaPrompt } : {}),
  };
}

function readGoogleTtsOverrides(
  overrides: SpeechProviderOverrides | undefined,
): GoogleTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: normalizeOptionalString(overrides.model),
    voiceName: normalizeOptionalString(overrides.voiceName ?? overrides.voice),
    audioProfile: normalizeOptionalString(overrides.audioProfile),
    speakerName: normalizeOptionalString(overrides.speakerName),
  };
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
): SpeechDirectiveTokenParseResult {
  switch (ctx.key) {
    case "voicename":
    case "voice_name":
    case "google_voice":
    case "googlevoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceName: ctx.value } };
    case "google_model":
    case "googlemodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    default:
      return { handled: false };
  }
}

type GoogleTtsSynthesisRequest = Pick<
  SpeechSynthesisRequest,
  "cfg" | "providerConfig" | "providerOverrides" | "text" | "timeoutMs"
>;

async function synthesizeConfiguredGoogleTts(req: GoogleTtsSynthesisRequest): Promise<Buffer> {
  const config = readGoogleTtsProviderConfig(req.providerConfig);
  const overrides = readGoogleTtsOverrides(req.providerOverrides);
  const apiKey = resolveGoogleTtsApiKey({
    cfg: req.cfg,
    providerConfig: config,
  });
  if (!apiKey) {
    throw new Error("Google API key missing");
  }
  const { sanitizeConfiguredModelProviderRequest } =
    await import("openclaw/plugin-sdk/provider-http");
  const params = {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl ?? normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl),
    request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
    model: normalizeGoogleTtsModel(overrides.model ?? config.model),
    voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
    audioProfile: overrides.audioProfile ?? config.audioProfile,
    speakerName: overrides.speakerName ?? config.speakerName,
    speakers: config.speakers,
    personaPrompt: config.personaPrompt,
    timeoutMs: req.timeoutMs,
  };
  return retryAsync(() => synthesizeGoogleTtsPcmOnce(params), {
    attempts: 2,
    minDelayMs: 0,
    shouldRetry: isGoogleTtsRetryableError,
  });
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google",
    autoSelectOrder: 50,
    defaultModel: DEFAULT_GOOGLE_TTS_MODEL,
    models: GOOGLE_TTS_MODELS,
    voices: GOOGLE_PREBUILT_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeGoogleTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGoogleTtsProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.google.apiKey",
              }),
            }),
        ...(normalizeOptionalString(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeOptionalString(talkProviderConfig.baseUrl) }),
        ...(normalizeOptionalString(talkProviderConfig.modelId) == null
          ? {}
          : { model: normalizeGoogleTtsModel(talkProviderConfig.modelId) }),
        ...(normalizeOptionalString(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceName: normalizeGoogleTtsVoiceName(talkProviderConfig.voiceId) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(normalizeOptionalString(params.voiceId) == null
        ? {}
        : { voiceName: normalizeGoogleTtsVoiceName(params.voiceId) }),
      ...(normalizeOptionalString(params.modelId) == null
        ? {}
        : { model: normalizeGoogleTtsModel(params.modelId) }),
    }),
    listVoices: async () => GOOGLE_PREBUILT_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        resolveGoogleTtsApiKey({
          cfg,
          providerConfig: readGoogleTtsProviderConfig(providerConfig),
        }),
      ),
    prepareSynthesis: (ctx) => {
      const config = readGoogleTtsProviderConfig(ctx.providerConfig);
      const overrides = readGoogleTtsOverrides(ctx.providerOverrides);
      const model = normalizeGoogleTtsModel(overrides.model ?? config.model);
      assertSupportedGoogleTtsModel(model);
      if (isGoogleInteractionsTtsModel(model)) {
        return prepareGoogleInteractionsSynthesis(ctx.text);
      }
      const shouldWrap =
        config.promptTemplate === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE ||
        Boolean(config.personaPrompt);
      if (!shouldWrap || isOpenClawGoogleAudioProfilePrompt(ctx.text)) {
        return undefined;
      }
      return {
        text: renderGoogleAudioProfilePrompt({
          text: ctx.text,
          persona: ctx.persona,
          personaPrompt: config.personaPrompt,
        }),
      };
    },
    synthesize: async (req) => {
      const pcm = await synthesizeConfiguredGoogleTts(req);
      if (req.target === "voice-note") {
        const { transcodeAudioBufferToOpus } = await import("openclaw/plugin-sdk/media-runtime");
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer: wrapPcm16MonoToWav(pcm),
            inputExtension: "wav",
            tempPrefix: "tts-google-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer: wrapPcm16MonoToWav(pcm),
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const pcm = await synthesizeConfiguredGoogleTts(req);
      return {
        audioBuffer: pcm,
        outputFormat: "pcm",
        sampleRate: GOOGLE_TTS_SAMPLE_RATE,
      };
    },
  };
}
