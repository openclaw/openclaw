import {
  buildGoogleMusicGenerationBody,
  parseGoogleMusicGenerationResponse,
  type MusicGenerationProvider,
} from "openclaw/plugin-sdk/music-generation";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { toStandardGoogleProviderBase64 } from "./base64.js";
import type { GoogleGenerateContentResponse } from "./generate-content-response.js";
import { resolveGoogleGenerationApiKey } from "./generation-auth.js";
import {
  createGoogleMusicGenerationProviderMetadata,
  DEFAULT_GOOGLE_MUSIC_MODEL,
  GOOGLE_MAX_INPUT_IMAGES,
  GOOGLE_PRO_MUSIC_MODEL,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";
import { resolveGoogleGenerativeAiSdkHttpOptions } from "./src/google-api-base-url.js";

const DEFAULT_TIMEOUT_MS = 180_000;

function resolveTerminalNoAudioReason(payload: GoogleGenerateContentResponse): string | undefined {
  const blockReason = normalizeOptionalString(payload.promptFeedback?.blockReason);
  if (blockReason && !blockReason.endsWith("_UNSPECIFIED")) {
    return `prompt blocked (${blockReason})`;
  }
  for (const candidate of payload.candidates ?? []) {
    const finishReason = normalizeOptionalString(candidate.finishReason);
    if (finishReason && finishReason !== "STOP" && finishReason !== "FINISH_REASON_UNSPECIFIED") {
      return `generation stopped (${finishReason})`;
    }
  }
  return undefined;
}

export const googleMusicGenerationProvider: MusicGenerationProvider = {
  ...createGoogleMusicGenerationProviderMetadata(),
  async generateMusic(req) {
    req.signal?.throwIfAborted();
    if ((req.inputImages?.length ?? 0) > GOOGLE_MAX_INPUT_IMAGES) {
      throw new Error(
        `Google music generation supports at most ${GOOGLE_MAX_INPUT_IMAGES} reference images.`,
      );
    }
    const apiKey = await resolveGoogleGenerationApiKey(req);
    req.signal?.throwIfAborted();

    const model = normalizeOptionalString(req.model) || DEFAULT_GOOGLE_MUSIC_MODEL;
    if (req.format) {
      const supportedFormats = model === GOOGLE_PRO_MUSIC_MODEL ? ["mp3", "wav"] : ["mp3"];
      if (!supportedFormats.includes(req.format)) {
        throw new Error(
          `Google music generation model ${model} supports ${supportedFormats.join(", ")} output.`,
        );
      }
    }

    const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
    const httpOptions = resolveGoogleGenerativeAiSdkHttpOptions(configured);
    const operationTimeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = createProviderOperationDeadline({
      timeoutMs: operationTimeoutMs,
      label: "Google music generation",
    });
    const body = buildGoogleMusicGenerationBody(req);
    // Lyria promises audio for successful Clip responses, but has returned
    // unblocked text-only payloads transiently. Never retry explicit stops.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      req.signal?.throwIfAborted();
      const client = createGoogleGenAI({
        apiKey,
        httpOptions: {
          ...httpOptions,
          timeout: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: operationTimeoutMs,
          }),
        },
      });
      const response = (await client.models.generateContent({
        model,
        contents: body.contents,
        config: {
          ...body.generationConfig,
          ...(req.signal ? { abortSignal: req.signal } : {}),
        },
      })) as GoogleGenerateContentResponse;
      req.signal?.throwIfAborted();
      const { tracks, lyrics } = parseGoogleMusicGenerationResponse({
        response,
        normalizeBase64: toStandardGoogleProviderBase64,
        defaultFileExtension: model === GOOGLE_PRO_MUSIC_MODEL ? "wav" : "mp3",
      });
      if (tracks.length > 0) {
        return {
          tracks,
          ...(lyrics ? { lyrics } : {}),
          model,
          metadata: {
            inputImageCount: req.inputImages?.length ?? 0,
            instrumental: req.instrumental === true,
            ...(normalizeOptionalString(req.lyrics) ? { requestedLyrics: true } : {}),
            ...(req.format ? { requestedFormat: req.format } : {}),
          },
        };
      }
      const terminalReason = resolveTerminalNoAudioReason(response);
      if (terminalReason) {
        throw new Error(`Google music generation returned no audio: ${terminalReason}`);
      }
    }
    throw new Error("Google music generation response missing audio data");
  },
};
