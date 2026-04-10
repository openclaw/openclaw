import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MUSIC_MODEL = "openai/gpt-4o-audio-preview";
const OPENROUTER_MUSIC_MODELS = ["openai/gpt-4o-audio-preview"] as const;
const DEFAULT_TIMEOUT_MS = 120_000;

function resolveConfiguredBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string }> } } | undefined,
): string | undefined {
  return normalizeOptionalString(cfg?.models?.providers?.openrouter?.baseUrl);
}

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

function resolveAudioFormat(req: MusicGenerationRequest): string {
  if (req.format === "wav") {
    return "wav";
  }
  return "mp3";
}

function resolveOutputMimeType(format: string): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

type SseAudioChunk = {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string;
        transcript?: string;
      };
    };
  }>;
};

async function collectStreamedAudio(
  response: Response,
): Promise<{ audioBase64: string; transcript: string }> {
  const audioChunks: string[] = [];
  const transcriptParts: string[] = [];

  const body = response.body;
  if (!body) {
    throw new Error("OpenRouter audio response missing stream body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        continue;
      }
      let parsed: SseAudioChunk;
      try {
        parsed = JSON.parse(payload) as SseAudioChunk;
      } catch {
        continue;
      }
      const audioDelta = parsed.choices?.[0]?.delta?.audio;
      if (!audioDelta) {
        continue;
      }
      const data = normalizeOptionalString(audioDelta.data);
      if (data) {
        audioChunks.push(data);
      }
      const transcript = normalizeOptionalString(audioDelta.transcript);
      if (transcript) {
        transcriptParts.push(transcript);
      }
    }
  }

  return {
    audioBase64: audioChunks.join(""),
    transcript: transcriptParts.join(""),
  };
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

      const { baseUrl, headers } = resolveProviderHttpRequestConfig({
        baseUrl: resolveConfiguredBaseUrl(req.cfg),
        defaultBaseUrl: OPENROUTER_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
        },
        provider: "openrouter",
        capability: "music",
        transport: "http",
      });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_MUSIC_MODEL;
      const audioFormat = resolveAudioFormat(req);

      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      const response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: buildMusicPrompt(req) }],
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: audioFormat },
            stream: true,
          }),
        },
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetch,
      );
      await assertOkOrThrowHttpError(response, "OpenRouter music generation failed");

      const { audioBase64, transcript } = await collectStreamedAudio(response);
      if (!audioBase64) {
        throw new Error("OpenRouter music generation response missing audio data");
      }

      const mimeType = resolveOutputMimeType(audioFormat);
      const extension = audioFormat === "wav" ? "wav" : "mp3";
      const track: GeneratedMusicAsset = {
        buffer: Buffer.from(audioBase64, "base64"),
        mimeType,
        fileName: `track-1.${extension}`,
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
    },
  };
}
