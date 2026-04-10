import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";
import { collectStreamedAudio } from "./streaming-audio.js";

const DEFAULT_OPENROUTER_MUSIC_MODEL = "google/lyria-3-clip-preview";
const OPENROUTER_MUSIC_MODELS = [
  "google/lyria-3-clip-preview",
  "google/lyria-3-pro-preview",
] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

function buildMusicPrompt(req: MusicGenerationRequest): string {
  const parts = [req.prompt.trim()];
  const lyrics = normalizeOptionalString(req.lyrics);
  if (req.instrumental === true) {
    parts.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
  }
  if (lyrics) {
    parts.push(`Lyrics:\n${lyrics}`);
  }
  return parts.join("\n\n");
}

export function buildOpenrouterMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_MUSIC_MODEL,
    models: [...OPENROUTER_MUSIC_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormats: ["mp3", "wav"],
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const { baseUrl, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
        baseUrl: resolveConfiguredBaseUrl(req.cfg),
        defaultBaseUrl: OPENROUTER_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
        },
        provider: "openrouter",
        capability: "audio",
        transport: "http",
      });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_MUSIC_MODEL;
      const audioFormat = req.format === "wav" ? "wav" : "mp3";

      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      const { response, release } = await fetchWithTimeoutGuarded(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: buildMusicPrompt(req) }],
            modalities: ["text", "audio"],
            audio: { format: audioFormat },
            stream: true,
          }),
        },
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetch,
        { dispatcherPolicy, auditContext: "openrouter-music-generate" },
      );

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter music generation failed");
        const { audioBuffer, transcript } = await collectStreamedAudio(response);
        if (audioBuffer.length === 0) {
          throw new Error("OpenRouter music generation response missing audio data");
        }

        const mimeType = audioFormat === "wav" ? "audio/wav" : "audio/mpeg";
        const track: GeneratedMusicAsset = {
          buffer: audioBuffer,
          mimeType,
          fileName: `track-1.${audioFormat}`,
        };

        return {
          tracks: [track],
          ...(transcript ? { lyrics: [transcript] } : {}),
          model,
          metadata: {
            audioFormat,
            instrumental: req.instrumental === true,
            ...(normalizeOptionalString(req.lyrics) ? { requestedLyrics: true } : {}),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
