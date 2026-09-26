import type { sanitizeConfiguredModelProviderRequest } from "openclaw/plugin-sdk/provider-http";
import {
  normalizeOptionalString,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildGoogleInteractionsTtsBody,
  splitGoogleTtsDialogue,
  type GoogleTtsDialogueSpeaker,
} from "./speech-dialogue.js";
import { assertSupportedGoogleTtsModel, isGoogleInteractionsTtsModel } from "./speech-models.js";

export const GOOGLE_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TTS_CHANNELS = 1;
const GOOGLE_TTS_BITS_PER_SAMPLE = 16;

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateSpeechResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

type GoogleInteractionsAudioBlock = GoogleInlineDataPart & {
  type?: string;
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

export function isGoogleTtsRetryableError(err: unknown): boolean {
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

function composeGoogleTtsText(params: {
  text: string;
  audioProfile?: string;
  speakerName?: string;
}): string {
  return [
    trimToUndefined(params.audioProfile),
    trimToUndefined(params.speakerName) ? `Speaker name: ${params.speakerName}` : undefined,
    params.text,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function normalizePromptSectionText(value: string | undefined): string | undefined {
  const trimmed = trimToUndefined(value?.replace(/\r\n?/g, "\n"));
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

export function isOpenClawGoogleAudioProfilePrompt(text: string): boolean {
  return (
    text.includes("# AUDIO PROFILE:") &&
    text.includes("### TRANSCRIPT") &&
    text.startsWith("Synthesize speech from the TRANSCRIPT section only.")
  );
}

export function renderGoogleAudioProfilePrompt(params: {
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

export function wrapPcm16MonoToWav(pcm: Buffer, sampleRate = GOOGLE_TTS_SAMPLE_RATE): Buffer {
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

export function prepareGoogleInteractionsSynthesis(params: {
  text: string;
  personaPrompt?: string;
  persona?: { id: string; label?: string };
}): { text?: string; providerConfig?: { personaPrompt: string } } | undefined {
  const transcript = extractOpenClawGoogleAudioProfileTranscript(params.text);
  const label =
    normalizePromptSectionText(params.persona?.label) ??
    normalizePromptSectionText(params.persona?.id);
  const notes = [
    label ? `Persona: ${label}` : undefined,
    normalizePromptSectionText(params.personaPrompt),
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const providerConfig =
    notes && notes !== trimToUndefined(params.personaPrompt) ? { personaPrompt: notes } : undefined;
  if (!transcript && !providerConfig) {
    return undefined;
  }
  return {
    ...(transcript ? { text: transcript } : {}),
    ...(providerConfig ? { providerConfig } : {}),
  };
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

export async function synthesizeGoogleTtsPcmOnce(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  model: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  speakers?: GoogleTtsDialogueSpeaker[];
  personaPrompt?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  assertSupportedGoogleTtsModel(params.model);
  const interactions = isGoogleInteractionsTtsModel(params.model);
  if (!interactions && params.speakers && splitGoogleTtsDialogue(params.text, params.speakers)) {
    throw new Error(
      "Google TTS multi-speaker dialogue requires gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts.",
    );
  }
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
        GoogleGenerateSpeechResponse & GoogleInteractionsSpeechResponse
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
