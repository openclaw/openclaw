import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  downloadGeneratedMusicAsset,
  extractGeneratedMusicFileCandidates,
  type MusicGenerationProvider,
  type MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { postJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFalHttpRequestConfig } from "./http-config.js";

const DEFAULT_FAL_MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const FAL_ACE_STEP_MODEL = "fal-ai/ace-step/prompt-to-audio";
const FAL_STABLE_AUDIO_MODEL = "fal-ai/stable-audio-25/text-to-audio";
const DEFAULT_TIMEOUT_MS = 180_000;

const FAL_MUSIC_MODELS = [
  DEFAULT_FAL_MUSIC_MODEL,
  FAL_ACE_STEP_MODEL,
  FAL_STABLE_AUDIO_MODEL,
] as const;

function buildFalMusicRequestBody(
  req: MusicGenerationRequest,
  model: string,
): Record<string, unknown> {
  const lyrics = normalizeOptionalString(req.lyrics);
  if (model === FAL_ACE_STEP_MODEL || model === FAL_STABLE_AUDIO_MODEL) {
    const isStableAudio = model === FAL_STABLE_AUDIO_MODEL;
    if (lyrics) {
      throw new Error(
        `fal ${isStableAudio ? "Stable Audio" : "ACE-Step"} music generation does not support explicit lyrics.`,
      );
    }
    if (isStableAudio && req.instrumental === true) {
      throw new Error("fal Stable Audio music generation does not support instrumental mode.");
    }
    return {
      prompt: req.prompt,
      ...(req.instrumental === true ? { instrumental: true } : {}),
      ...(req.durationSeconds !== undefined
        ? { [isStableAudio ? "seconds_total" : "duration"]: req.durationSeconds }
        : {}),
    };
  }
  if (lyrics && req.instrumental === true) {
    throw new Error("fal MiniMax music generation cannot use lyrics when instrumental=true.");
  }
  return {
    prompt: req.prompt,
    ...(lyrics ? { lyrics } : {}),
    ...(req.instrumental === true ? { is_instrumental: true } : {}),
    ...(!lyrics && req.instrumental !== true ? { lyrics_optimizer: true } : {}),
    ...(req.durationSeconds !== undefined ? { duration: req.durationSeconds } : {}),
    audio_setting: {
      sample_rate: 44_100,
      bitrate: 256_000,
      format: req.format ?? "mp3",
    },
  };
}

export function buildFalMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_MUSIC_MODEL,
    models: [...FAL_MUSIC_MODELS],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "fal", ...ctx }),
    capabilities: {
      generate: {
        maxTracks: 1,
        maxDurationSeconds: 240,
        supportsLyrics: true,
        supportsLyricsByModel: {
          [FAL_ACE_STEP_MODEL]: false,
          [FAL_STABLE_AUDIO_MODEL]: false,
        },
        supportsInstrumental: true,
        supportsInstrumentalByModel: {
          [FAL_STABLE_AUDIO_MODEL]: false,
        },
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
        supportedFormatsByModel: {
          [DEFAULT_FAL_MUSIC_MODEL]: ["mp3"],
          [FAL_ACE_STEP_MODEL]: ["wav"],
          [FAL_STABLE_AUDIO_MODEL]: ["wav"],
        },
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("fal music generation does not support image reference inputs.");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveFalHttpRequestConfig({ req, capability: "audio" });
      const model = normalizeOptionalString(req.model) ?? DEFAULT_FAL_MUSIC_MODEL;
      const payload = await postJsonResponse<unknown>({
        url: `${baseUrl}/${model}`,
        headers,
        body: buildFalMusicRequestBody(req, model),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        errorLabel: "fal music generation failed",
        responseLabel: "fal music generation",
      });
      const [candidate] = extractGeneratedMusicFileCandidates(payload);
      if (!candidate) {
        throw new Error("fal music generation response missing audio output");
      }
      const track = await downloadGeneratedMusicAsset({
        candidate,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        provider: "fal",
        requestFailedMessage: "fal generated music download failed",
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
        validateBinaryResponse: true,
        // Preserve fal's deadline-only timing when enabling the shared binary reader.
        chunkTimeoutMs: 0,
      });
      const record = isRecord(payload) ? payload : undefined;
      const lyrics = normalizeOptionalString(record?.lyrics);
      const metadata: Record<string, unknown> = {};
      for (const key of ["seed", "tags"]) {
        const value = record?.[key];
        if (value !== undefined && value !== null) {
          metadata[key] = value;
        }
      }
      return {
        tracks: [track],
        model,
        ...(lyrics ? { lyrics: [lyrics] } : {}),
        metadata: {
          ...metadata,
          ...(track.metadata?.url ? { audioUrl: track.metadata.url } : {}),
          instrumental: req.instrumental === true,
          ...(req.format ? { requestedFormat: req.format } : {}),
          ...(req.durationSeconds !== undefined
            ? { requestedDurationSeconds: req.durationSeconds }
            : {}),
        },
      };
    },
  };
}
