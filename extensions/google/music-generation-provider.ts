import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { generatedMusicAssetFromBase64 } from "openclaw/plugin-sdk/music-generation";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
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
import { resolveGoogleGenerativeAiApiOrigin } from "./provider-policy.js";

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
    if ((req.inputImages?.length ?? 0) > GOOGLE_MAX_INPUT_IMAGES) {
      throw new Error(
        `Google music generation supports at most ${GOOGLE_MAX_INPUT_IMAGES} reference images.`,
      );
    }
    const apiKey = await resolveGoogleGenerationApiKey(req);

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
    const configuredBaseUrl = configured
      ? resolveGoogleGenerativeAiApiOrigin(configured)
      : undefined;
    const operationTimeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = createProviderOperationDeadline({
      timeoutMs: operationTimeoutMs,
      label: "Google music generation",
    });
    // Lyria promises audio for successful Clip responses, but has returned
    // unblocked text-only payloads transiently. Never retry explicit stops.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = createGoogleGenAI({
        apiKey,
        httpOptions: {
          ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
          timeout: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: operationTimeoutMs,
          }),
        },
      });
      const parts = [req.prompt.trim()];
      const promptLyrics = normalizeOptionalString(req.lyrics);
      if (req.instrumental === true) {
        parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
      }
      if (promptLyrics) {
        parts.push(`Lyrics:\n${promptLyrics}`);
      }
      const response = (await client.models.generateContent({
        model,
        contents: [
          { text: parts.join("\n\n") },
          ...(req.inputImages ?? []).map((image) => ({
            inlineData: {
              mimeType: normalizeOptionalString(image.mimeType) || "image/png",
              data: image.buffer?.toString("base64") ?? "",
            },
          })),
        ],
        config: {
          responseModalities: ["AUDIO", "TEXT"],
        },
      })) as GoogleGenerateContentResponse;
      const lyrics: string[] = [];
      const tracks: GeneratedMusicAsset[] = [];
      for (const candidate of response.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const text = normalizeOptionalString(part.text);
          if (text) {
            lyrics.push(text);
            continue;
          }
          const inline = part.inlineData ?? part.inline_data;
          const data = normalizeOptionalString(inline?.data);
          if (!data) {
            continue;
          }
          const mimeType =
            normalizeOptionalString(inline?.mimeType) ||
            normalizeOptionalString(inline?.mime_type) ||
            "audio/mpeg";
          const standardAudio = toStandardGoogleProviderBase64(data);
          if (!standardAudio) {
            throw new Error("Generated music asset contains malformed base64 audio data");
          }
          const ext =
            extensionForMime(mimeType)?.replace(/^\./u, "") ||
            (model === GOOGLE_PRO_MUSIC_MODEL ? "wav" : "mp3");
          tracks.push(
            generatedMusicAssetFromBase64({
              base64: standardAudio,
              mimeType,
              fileName: `track-${tracks.length + 1}.${ext}`,
            }),
          );
        }
      }
      if (tracks.length > 0) {
        return {
          tracks,
          ...(lyrics.length > 0 ? { lyrics } : {}),
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
