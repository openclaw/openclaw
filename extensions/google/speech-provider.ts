import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { createSpeechDirectiveParser, retryAsync } from "openclaw/plugin-sdk/speech-provider";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleEnvApiKey } from "./gemini-auth.js";
import type { GoogleGenerateContentResponse } from "./generate-content-response.js";
import {
  readGoogleTtsSpeakers,
  buildGoogleInteractionsTtsBody,
  splitGoogleTtsDialogue,
} from "./speech-dialogue.js";
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
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

const GOOGLE_TTS_CHANNELS = 1;

const GOOGLE_TTS_BITS_PER_SAMPLE = 16;

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

function normalizePromptSectionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value?.replace(/\r\n?/g, "\n"));
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\p{Cc}/gu, (char) =>
    "\t\n\r".includes(char) || char.charCodeAt(0) > 127 ? char : "",
  );
}

function isOpenClawGoogleAudioProfilePrompt(text: string): boolean {
  return (
    text.includes("# AUDIO PROFILE:") &&
    text.includes("### TRANSCRIPT") &&
    text.startsWith("Synthesize speech from the TRANSCRIPT section only.")
  );
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

type GoogleTtsProviderOverrides = Partial<
  Pick<
    ReturnType<typeof readGoogleTtsProviderConfig>,
    "model" | "voiceName" | "audioProfile" | "speakerName"
  >
>;

function resolveGoogleTtsApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: Partial<Pick<ReturnType<typeof readGoogleTtsProviderConfig>, "apiKey">>;
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

function normalizeGoogleTtsProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.google);
  return {
    ...readGoogleTtsProviderConfig(raw ?? {}),
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.google.apiKey",
    }),
  };
}

function readGoogleTtsProviderConfig(config: SpeechProviderConfig) {
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

const parseDirectiveToken = createSpeechDirectiveParser({
  voiceName: ["allowVoice", ["voicename", "voice_name", "google_voice", "googlevoice"]],
  model: ["allowModelId", ["google_model", "googlemodel"]],
});

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
  const { isTransientNetworkError } = await import("openclaw/plugin-sdk/retry-runtime");
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
  return retryAsync(
    async () => {
      assertSupportedGoogleTtsModel(params.model);
      const interactions = isGoogleInteractionsTtsModel(params.model);
      if (
        !interactions &&
        params.speakers &&
        splitGoogleTtsDialogue(params.text, params.speakers)
      ) {
        throw new Error(
          "Google TTS multi-speaker dialogue requires gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts.",
        );
      }
      const { assertOkOrThrowProviderError, postJsonRequest, readProviderJsonResponse } =
        await import("openclaw/plugin-sdk/provider-http");
      const { resolveGoogleGenerativeAiHttpRequestConfig } = await import("./http-request.js");
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
                      text: [
                        normalizeOptionalString(params.audioProfile),
                        normalizeOptionalString(params.speakerName)
                          ? `Speaker name: ${params.speakerName}`
                          : undefined,
                        params.text,
                      ]
                        .filter((part): part is string => part !== undefined)
                        .join("\n\n"),
                    },
                  ],
                },
              ],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: params.voiceName,
                    },
                  },
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
            await assertOkOrThrowProviderError(res, "Google TTS failed", {
              requestHeaders: headers,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (res.status >= 500 && res.status < 600) {
              throw new GoogleTtsRetryableError(message);
            }
            throw err;
          }
        }
        const payload = await readProviderJsonResponse<
          GoogleGenerateContentResponse & GoogleInteractionsSpeechResponse
        >(res, "Google TTS response", {
          requestHeaders: headers,
          onIdleTimeout: ({ chunkTimeoutMs }) =>
            new GoogleTtsRetryableError(
              `Google TTS response: response body stalled for ${chunkTimeoutMs}ms`,
            ),
        });
        const encoded = interactions
          ? readGoogleInteractionsAudioData(payload)
          : payload.candidates
              ?.flatMap((candidate) => candidate.content?.parts ?? [])
              .map((part) => normalizeOptionalString((part.inlineData ?? part.inline_data)?.data))
              .find((data): data is string => data !== undefined);
        if (!encoded) {
          throw new GoogleTtsRetryableError("Google TTS response missing audio data");
        }
        const canonicalAudio = canonicalizeGoogleProviderBase64(encoded);
        if (!canonicalAudio) {
          throw new Error("Google TTS response returned malformed base64 audio data");
        }
        return stripWavContainerToPcm(Buffer.from(canonicalAudio, "base64"));
      } finally {
        await release();
      }
    },
    {
      attempts: 2,
      minDelayMs: 0,
      shouldRetry: (err) => isGoogleTtsRetryableError(err) || isTransientNetworkError(err),
    },
  );
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({
    cfg,
    providerConfig,
  }) =>
    Boolean(
      resolveGoogleTtsApiKey({
        cfg,
        providerConfig: readGoogleTtsProviderConfig(providerConfig),
      }),
    );
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
      const baseUrl = normalizeOptionalString(talkProviderConfig.baseUrl);
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
        ...(baseUrl ? { baseUrl } : {}),
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
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    prepareSynthesis: (ctx) => {
      const config = readGoogleTtsProviderConfig(ctx.providerConfig);
      const overrides = readGoogleTtsOverrides(ctx.providerOverrides);
      const model = normalizeGoogleTtsModel(overrides.model ?? config.model);
      assertSupportedGoogleTtsModel(model);
      if (isGoogleInteractionsTtsModel(model)) {
        // Gemini 3.8 speaks the transcript verbatim; the persona label is not delivery style.
        const transcript = extractOpenClawGoogleAudioProfileTranscript(ctx.text);
        return transcript ? { text: transcript } : undefined;
      }
      const shouldWrap =
        config.promptTemplate === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE ||
        Boolean(config.personaPrompt);
      if (!shouldWrap || isOpenClawGoogleAudioProfilePrompt(ctx.text)) {
        return undefined;
      }
      const transcript = ctx.text.replace(/\r\n?/g, "\n").trim();
      const personaPrompt = normalizePromptSectionText(config.personaPrompt);
      const label =
        normalizePromptSectionText(ctx.persona?.label) ??
        normalizePromptSectionText(ctx.persona?.id);

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
      return { text: sections.join("\n\n") };
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
