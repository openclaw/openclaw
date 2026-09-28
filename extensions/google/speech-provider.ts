import type { sanitizeConfiguredModelProviderRequest } from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
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
import type { GoogleGenerateContentResponse } from "./generate-content-response.js";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";
import { createGoogleSpeechVoiceMethods } from "./voices.js";

// Implicit default stays on the generateContent path; Gemini 3.8 is an explicit opt-in.
const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
const GOOGLE_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TTS_CHANNELS = 1;
const GOOGLE_TTS_BITS_PER_SAMPLE = 16;
const GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE = "audio-profile-v1";

const GOOGLE_TTS_INTERACTIONS_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
] as const;

const GOOGLE_TTS_GENERATE_CONTENT_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

const GOOGLE_TTS_MODELS = [
  ...GOOGLE_TTS_INTERACTIONS_MODELS,
  ...GOOGLE_TTS_GENERATE_CONTENT_MODELS,
] as const;

const GOOGLE_TTS_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-flash-tts": "gemini-3.1-flash-tts-preview",
};

type GoogleTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  promptTemplate?: typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE;
  personaPrompt?: string;
};

type GoogleTtsProviderOverrides = {
  model?: string;
  voiceName?: string;
  audioProfile?: string;
  speakerName?: string;
};

type GoogleInteractionsAudioBlock = {
  type?: string;
  mime_type?: string;
  mimeType?: string;
  data?: string;
};

type GoogleInteractionsSpeechResponse = {
  output_audio?: GoogleInteractionsAudioBlock;
  outputAudio?: GoogleInteractionsAudioBlock;
  steps?: Array<{
    content?: GoogleInteractionsAudioBlock[];
  }>;
};

class GoogleTtsRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTtsRetryableError";
  }
}

function isGoogleTtsRetryableError(err: unknown): boolean {
  if (err instanceof GoogleTtsRetryableError) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === "AbortError") {
    return true;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function normalizeGoogleTtsModel(model: unknown): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_GOOGLE_TTS_MODEL;
  }
  const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice("google/".length) : trimmed;
  return GOOGLE_TTS_MODEL_ALIASES[withoutProvider] ?? withoutProvider;
}

function isGoogleInteractionsTtsModel(model: string): boolean {
  // SAFETY: widening a readonly literal tuple to readonly string[] so includes() accepts any model id.
  return (GOOGLE_TTS_INTERACTIONS_MODELS as readonly string[]).includes(model);
}

function assertSupportedGoogleTtsModel(model: string): void {
  if (isGoogleInteractionsTtsModel(model)) {
    return;
  }
  if (model.includes("gemini-3.8-") && model.includes("-tts")) {
    throw new Error(
      `Google TTS model ${model} is not supported. OpenClaw sends Gemini 3.8 TTS through the Interactions API; supported models: ${GOOGLE_TTS_INTERACTIONS_MODELS.join(", ")}.`,
    );
  }
}

function normalizeGoogleTtsVoiceName(voiceName: unknown): string {
  return normalizeOptionalString(voiceName) ?? DEFAULT_GOOGLE_TTS_VOICE;
}

function isStoredGoogleTtsVoice(voiceName: string): boolean {
  return voiceName.startsWith("voice_");
}

function isGemini38TtsModel(model: string): boolean {
  return model.includes("gemini-3.8");
}

function googleTtsSpeechVoiceConfig(voiceName: string): Record<string, unknown> {
  if (isStoredGoogleTtsVoice(voiceName)) {
    return { voice: voiceName };
  }
  return { prebuiltVoiceConfig: { voiceName } };
}

function normalizeGooglePromptTemplate(
  value: unknown,
): typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE) {
    return trimmed;
  }
  throw new Error(`Invalid Google TTS promptTemplate: ${trimmed}`);
}

function resolveGoogleTtsModelProviderApiKey(cfg?: OpenClawConfig): string | undefined {
  return normalizeResolvedSecretInputString({
    value: cfg?.models?.providers?.google?.apiKey,
    path: "models.providers.google.apiKey",
  });
}

function resolveGoogleTtsApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
}): string | undefined {
  return (
    readGoogleTtsProviderConfig(params.providerConfig).apiKey ??
    resolveGoogleTtsModelProviderApiKey(params.cfg) ??
    resolveGoogleEnvApiKey()
  );
}

function resolveGoogleTtsBaseUrl(params: {
  cfg?: OpenClawConfig;
  providerConfig: GoogleTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.baseUrl ??
    normalizeOptionalString(params.cfg?.models?.providers?.google?.baseUrl)
  );
}

function resolveGoogleTtsConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(rawConfig.providers);
  return asOptionalRecord(providers?.google) ?? asOptionalRecord(rawConfig.google);
}

function normalizeGoogleTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): GoogleTtsProviderConfig {
  const raw = resolveGoogleTtsConfigRecord(rawConfig);
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
  return {
    apiKey: normalizeOptionalString(config.apiKey),
    baseUrl: normalizeOptionalString(config.baseUrl),
    model: normalizeGoogleTtsModel(config.model),
    voiceName: normalizeGoogleTtsVoiceName(config.voiceName ?? config.voice),
    audioProfile: normalizeOptionalString(config.audioProfile),
    speakerName: normalizeOptionalString(config.speakerName),
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

function composeGoogleTtsText(params: {
  text: string;
  audioProfile?: string;
  speakerName?: string;
}): string {
  return [
    normalizeOptionalString(params.audioProfile),
    normalizeOptionalString(params.speakerName) ? `Speaker name: ${params.speakerName}` : undefined,
    params.text,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function googleTtsContentPart(params: {
  text: string;
  model: string;
  audioProfile?: string;
  speakerName?: string;
}): Record<string, unknown> {
  if (!isGemini38TtsModel(params.model)) {
    return { text: composeGoogleTtsText(params) };
  }
  const style = normalizeOptionalString(params.audioProfile);
  const speaker = normalizeOptionalString(params.speakerName);
  return {
    text: params.text,
    ...(style || speaker
      ? {
          speechMetadata: {
            ...(style ? { style } : {}),
            ...(speaker ? { speaker } : {}),
          },
        }
      : {}),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
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

function normalizePromptSectionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value?.replace(/\r\n?/g, "\n"));
  if (!trimmed) {
    return undefined;
  }
  let sanitized = "";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    sanitized += char;
  }
  return sanitized;
}

function isOpenClawGoogleAudioProfilePrompt(text: string): boolean {
  return (
    text.includes("# AUDIO PROFILE:") &&
    text.includes("### TRANSCRIPT") &&
    text.startsWith("Synthesize speech from the TRANSCRIPT section only.")
  );
}

function renderGoogleAudioProfilePrompt(params: {
  text: string;
  persona?: {
    id: string;
    label?: string;
  };
  personaPrompt?: string;
}): string {
  const transcript = params.text.replace(/\r\n?/g, "\n").trim();
  const personaPrompt = normalizePromptSectionText(params.personaPrompt);
  const label =
    normalizePromptSectionText(params.persona?.label) ??
    normalizePromptSectionText(params.persona?.id);

  const sections = [
    [
      "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
      "as performance direction. Do not read section titles, notes, labels, or",
      "configuration aloud.",
    ].join("\n"),
  ];

  if (label) {
    sections.push(`# AUDIO PROFILE: ${label}`);
  }

  if (personaPrompt) {
    sections.push(["### DIRECTOR'S NOTES", "Provider notes:", personaPrompt].join("\n"));
  }

  sections.push(["### TRANSCRIPT", transcript].join("\n"));
  return sections.join("\n\n");
}

function wrapPcm16MonoToWav(pcm: Buffer, sampleRate = GOOGLE_TTS_SAMPLE_RATE): Buffer {
  const byteRate = sampleRate * GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const blockAlign = GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(GOOGLE_TTS_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(GOOGLE_TTS_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

// Google's 3.8 prompting guidance keeps `style` to delivery direction: speaker labels go in
// the structured `speaker` field and voice identity comes from the selected voice, so
// speaker and persona names are never folded into the style text.
function composeGoogleInteractionsSpeechStyle(params: {
  audioProfile?: string;
  personaPrompt?: string;
}): string | undefined {
  const style = [
    normalizeOptionalString(params.audioProfile),
    normalizeOptionalString(params.personaPrompt),
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return style || undefined;
}

function extractOpenClawGoogleAudioProfileTranscript(text: string): string | undefined {
  if (!isOpenClawGoogleAudioProfilePrompt(text)) {
    return undefined;
  }
  // The wrapper emits the delimiter as its own line after a blank line and the transcript is
  // always the last section, so the first structural delimiter wins. A later "### TRANSCRIPT"
  // inside the spoken text is content, not structure.
  const match = /\n\n### TRANSCRIPT(?:\n|$)/u.exec(text);
  if (!match) {
    return undefined;
  }
  return text.slice(match.index + match[0].length).trim() || undefined;
}

// Gemini 3.8 speaks the transcript verbatim, so a wrapped audio-profile prompt is reduced to
// its transcript. The persona label is identity, not delivery, and is not sent as style.
function prepareGoogleInteractionsSynthesis(text: string): { text: string } | undefined {
  const transcript = extractOpenClawGoogleAudioProfileTranscript(text);
  return transcript ? { text: transcript } : undefined;
}

function stripWavContainerToPcm(audio: Buffer): Buffer {
  if (
    audio.subarray(0, 4).toString("ascii") !== "RIFF" ||
    audio.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    return audio;
  }
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = audio.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return audio.subarray(dataStart, Math.min(dataStart + chunkSize, audio.length));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  throw new Error("Google TTS WAV response missing PCM data");
}

function readGoogleInteractionsAudioData(
  payload: GoogleInteractionsSpeechResponse,
): string | undefined {
  const direct = normalizeOptionalString(payload.output_audio?.data ?? payload.outputAudio?.data);
  if (direct) {
    return direct;
  }
  for (const step of payload.steps ?? []) {
    for (const block of step.content ?? []) {
      const mime = block.mimeType ?? block.mime_type;
      if (block.type !== "audio" && !mime?.startsWith("audio/")) {
        continue;
      }
      const data = normalizeOptionalString(block.data);
      if (data) {
        return data;
      }
    }
  }
  return undefined;
}

function buildGoogleInteractionsTtsBody(params: {
  model: string;
  text: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  personaPrompt?: string;
}): Record<string, unknown> {
  const style = composeGoogleInteractionsSpeechStyle(params);
  const speaker = normalizeOptionalString(params.speakerName);
  const textBlock: Record<string, unknown> = {
    type: "text",
    text: params.text,
  };
  if (style || speaker) {
    textBlock.annotations = [
      {
        type: "speech_metadata",
        ...(speaker ? { speaker } : {}),
        ...(style ? { style } : {}),
      },
    ];
  }
  return {
    model: params.model,
    // Interactions stores requests by default (55 days paid / 1 day free); TTS is stateless.
    store: false,
    input: [{ type: "user_input", content: [textBlock] }],
    response_format: {
      type: "audio",
      mime_type: "audio/l16",
      sample_rate: GOOGLE_TTS_SAMPLE_RATE,
    },
    generation_config: {
      // Single-voice requests keep the array form. Google only accepts a per-speaker voice map
      // for two-speaker dialogue (live probe 2026-09-28: one entry is rejected with HTTP 400), so
      // the speaker label travels in speech_metadata.speaker and the voice stays the selected one.
      speech_config: [{ voice: params.voiceName }],
    },
  };
}

async function synthesizeGoogleTtsPcmOnce(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  personaPrompt?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  assertSupportedGoogleTtsModel(params.model);
  const interactions = isGoogleInteractionsTtsModel(params.model);
  const { assertOkOrThrowProviderError, postJsonRequest, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { resolveGoogleGenerativeAiHttpRequestConfig } = await import("./api.js");
  const { canonicalizeGoogleProviderBase64 } = await import("./base64.js");
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      request: params.request,
      capability: "audio",
      transport: "http",
    });

  const { response: res, release } = await postJsonRequest({
    url: interactions
      ? `${baseUrl}/interactions`
      : `${baseUrl}/models/${params.model}:generateContent`,
    headers,
    body: interactions
      ? buildGoogleInteractionsTtsBody(params)
      : {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: composeGoogleTtsText({
                    text: params.text,
                    audioProfile: params.audioProfile,
                    speakerName: params.speakerName,
                  }),
                },
              ],
            },
          ],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: googleTtsSpeechVoiceConfig(params.voiceName),
            },
          },
        },
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    pinDns: false,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    if (!res.ok) {
      try {
        await assertOkOrThrowProviderError(res, "Google TTS failed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (res.status >= 500 && res.status < 600) {
          throw new GoogleTtsRetryableError(message);
        }
        throw err;
      }
    }
    try {
      const payload = await readProviderJsonResponse<
        GoogleGenerateContentResponse & GoogleInteractionsSpeechResponse
      >(res, "Google TTS response");
      const encoded = interactions
        ? readGoogleInteractionsAudioData(payload)
        : payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts ?? [])
            .map((part) => normalizeOptionalString((part.inlineData ?? part.inline_data)?.data))
            .find((data): data is string => data !== undefined);
      if (!encoded) {
        throw new Error("Google TTS response missing audio data");
      }
      const canonicalAudio = canonicalizeGoogleProviderBase64(encoded);
      if (!canonicalAudio) {
        throw new Error("Google TTS response returned malformed base64 audio data");
      }
      return stripWavContainerToPcm(Buffer.from(canonicalAudio, "base64"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GoogleTtsRetryableError(message);
    }
  } finally {
    await release();
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
    providerConfig: req.providerConfig,
  });
  if (!apiKey) {
    throw new Error("Google API key missing");
  }
  const { sanitizeConfiguredModelProviderRequest } =
    await import("openclaw/plugin-sdk/provider-http");
  const params = {
    text: req.text,
    apiKey,
    baseUrl: resolveGoogleTtsBaseUrl({ cfg: req.cfg, providerConfig: config }),
    request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
    voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
    model: normalizeGoogleTtsModel(overrides.model ?? config.model),
    audioProfile: overrides.audioProfile ?? config.audioProfile,
    speakerName: overrides.speakerName ?? config.speakerName,
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
    ...createGoogleSpeechVoiceMethods({
      readConfig: readGoogleTtsProviderConfig,
      resolveApiKey: resolveGoogleTtsApiKey,
      resolveBaseUrl: resolveGoogleTtsBaseUrl,
    }),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(resolveGoogleTtsApiKey({ cfg, providerConfig })),
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
