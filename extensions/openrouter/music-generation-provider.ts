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
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";

const DEFAULT_OPENROUTER_MUSIC_MODEL = "openai/gpt-4o-audio-preview";
const OPENROUTER_MUSIC_MODELS = ["openai/gpt-4o-audio-preview"] as const;
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
): Promise<{ audioBuffer: Buffer; transcript: string }> {
  // Decode each base64 chunk individually to avoid corruption from padding chars mid-string.
  const audioBuffers: Buffer[] = [];
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
      const data = audioDelta.data;
      if (typeof data === "string" && data.length > 0) {
        audioBuffers.push(Buffer.from(data, "base64"));
      }
      const transcript = audioDelta.transcript;
      if (typeof transcript === "string" && transcript.length > 0) {
        transcriptParts.push(transcript);
      }
    }
  }

  return {
    audioBuffer: Buffer.concat(audioBuffers),
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
        capability: "audio",
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

      const { audioBuffer, transcript } = await collectStreamedAudio(response);
      if (audioBuffer.length === 0) {
        throw new Error("OpenRouter music generation response missing audio data");
      }

      const mimeType = resolveOutputMimeType(audioFormat);
      const extension = audioFormat === "wav" ? "wav" : "mp3";
      const track: GeneratedMusicAsset = {
        buffer: audioBuffer,
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
