import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  readOpenRouterAudioStream,
  type MusicGenerationProvider,
  type MusicGenerationSourceImage,
} from "openclaw/plugin-sdk/music-generation";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { assertOkOrThrowHttpError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenRouterGenerationRequestContext } from "./generation-request-context.js";

const DEFAULT_OPENROUTER_MUSIC_MODEL = "google/lyria-3-pro-preview";
const OPENROUTER_CLIP_MUSIC_MODEL = "google/lyria-3-clip-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const OPENROUTER_MUSIC_MODELS = [
  DEFAULT_OPENROUTER_MUSIC_MODEL,
  OPENROUTER_CLIP_MUSIC_MODEL,
] as const;

function imageToContentPart(image: MusicGenerationSourceImage) {
  const url =
    normalizeOptionalString(image.url) ??
    (image.buffer
      ? toImageDataUrl({ ...image, buffer: image.buffer, defaultMimeType: "image/png" })
      : undefined);
  if (!url) {
    throw new Error("OpenRouter music generation reference image is missing data.");
  }
  return {
    type: "image_url",
    image_url: { url },
  };
}

export function buildOpenRouterMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_MUSIC_MODEL,
    models: [...OPENROUTER_MUSIC_MODELS],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "openrouter", ...ctx }),
    capabilities: {
      generate: {
        maxTracks: 1,
        maxDurationSeconds: 180,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
      edit: {
        enabled: true,
        maxTracks: 1,
        maxInputImages: 1,
        maxDurationSeconds: 180,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("OpenRouter music generation supports at most one reference image.");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveOpenRouterGenerationRequestContext({
          cfg: req.cfg,
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "audio",
          jsonContentType: true,
        });
      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_MUSIC_MODEL;
      const format = req.format ?? "wav";
      const timeoutMs = resolvePositiveTimerTimeoutMs(req.timeoutMs, DEFAULT_TIMEOUT_MS);
      const parts = [req.prompt.trim()];
      const lyrics = normalizeOptionalString(req.lyrics);
      if (req.instrumental === true) {
        parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
      }
      if (lyrics) {
        parts.push(`Lyrics:\n${lyrics}`);
      }
      if (typeof req.durationSeconds === "number") {
        parts.push(`Target duration: about ${Math.round(req.durationSeconds)} seconds.`);
      }
      const prompt = parts.join("\n\n");
      const images = req.inputImages ?? [];
      const content =
        images.length === 0
          ? prompt
          : [{ type: "text", text: prompt }, ...images.map(imageToContentPart)];
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/chat/completions`,
        headers,
        body: {
          model,
          messages: [{ role: "user", content }],
          modalities: ["text", "audio"],
          audio: { format },
          stream: true,
        },
        timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter music generation failed");
        const streamResult = await readOpenRouterAudioStream(
          response,
          resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
        );
        if (streamResult.audioBuffer.byteLength === 0) {
          throw new Error("OpenRouter music generation response missing audio data");
        }
        return {
          tracks: [
            {
              buffer: streamResult.audioBuffer,
              mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav",
              fileName: `track-1.${format}`,
            },
          ],
          model,
          ...(streamResult.transcript ? { lyrics: [streamResult.transcript] } : {}),
          metadata: {
            inputImageCount: req.inputImages?.length ?? 0,
            instrumental: req.instrumental === true,
            requestedFormat: format,
          },
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(`OpenRouter music generation timed out after ${timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        await release();
      }
    },
  };
}
