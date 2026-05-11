import type {
  GeneratedMusicAsset,
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeoutGuarded,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/lyria-3-clip-preview";

type MusicDispatcherPolicy = NonNullable<
  Parameters<typeof fetchWithTimeoutGuarded>[4]
>["dispatcherPolicy"];
const DEFAULT_TIMEOUT_MS = 120_000;
const SUPPORTED_MODELS = [DEFAULT_MODEL, "google/lyria-3-pro-preview"] as const;
// OpenRouter currently returns MP3 regardless of requested format.
const SUPPORTED_FORMATS: readonly MusicGenerationOutputFormat[] = ["mp3"];

type OpenRouterMusicSSEDelta = {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string;
        transcript?: string;
      };
    };
  }>;
};

/**
 * Parse SSE stream from a ReadableStream and yield parsed data events.
 */
async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OpenRouterMusicSSEDelta> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") {
        if (dataLines.length > 0) {
          const jsonStr = dataLines.join("\n");
          dataLines = [];
          if (jsonStr.trim() === "[DONE]") {
            return;
          }
          try {
            yield JSON.parse(jsonStr) as OpenRouterMusicSSEDelta;
          } catch {
            // Skip unparseable events
          }
        }
        continue;
      }
      if (trimmed.startsWith("data:")) {
        const dataContent = trimmed.slice(5).trim();
        dataLines.push(dataContent || "");
      }
    }

    if (done) {
      if (dataLines.length > 0) {
        const jsonStr = dataLines.join("\n");
        if (jsonStr.trim() !== "[DONE]") {
          try {
            yield JSON.parse(jsonStr) as OpenRouterMusicSSEDelta;
          } catch {
            // Skip
          }
        }
      }
      return;
    }
  }
}

/**
 * Post to OpenRouter chat completions with SSE streaming, collect audio chunks.
 */
async function streamOpenRouterMusic(params: {
  baseUrl: string;
  headers: Headers;
  body: Record<string, unknown>;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy?: MusicDispatcherPolicy;
}): Promise<{ audioBuffer: Buffer; transcriptPieces: string[] }> {
  const url = `${params.baseUrl}/chat/completions`;

  const { response, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    params.timeoutMs,
    fetch,
    ((): Parameters<typeof fetchWithTimeoutGuarded>[4] => {
      const opts: Parameters<typeof fetchWithTimeoutGuarded>[4] = {
        auditContext: "openrouter-music",
      };
      if (params.allowPrivateNetwork) {
        opts.ssrfPolicy = { allowPrivateNetwork: true };
      }
      if (params.dispatcherPolicy) {
        opts.dispatcherPolicy = params.dispatcherPolicy;
      }
      return opts;
    })(),
  );

  try {
    await assertOkOrThrowHttpError(response, "OpenRouter music generation failed");

    if (!response.body) {
      throw new Error("OpenRouter music generation response has no body");
    }

    const reader = response.body.getReader();
    const audioDataStrings: string[] = [];
    const transcriptPieces: string[] = [];

    try {
      for await (const event of parseSSEStream(reader)) {
        const delta = event.choices?.[0]?.delta?.audio;
        if (delta?.data) {
          audioDataStrings.push(delta.data);
        }
        if (delta?.transcript) {
          transcriptPieces.push(delta.transcript);
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }

    if (audioDataStrings.length === 0) {
      throw new Error("OpenRouter music generation response missing audio data");
    }

    const audioChunks = audioDataStrings.map((s) => Buffer.from(s, "base64"));
    const audioBuffer = Buffer.concat(audioChunks);
    return { audioBuffer, transcriptPieces };
  } finally {
    void release();
  }
}

function buildMusicRequestBody(
  req: MusicGenerationRequest,
  model: string,
  format?: string,
): Record<string, unknown> {
  let promptText = req.prompt.trim();
  const lyrics = normalizeOptionalString(req.lyrics);
  if (lyrics) {
    promptText += `\n\nLyrics:\n${lyrics}`;
  }
  if (req.instrumental === true) {
    promptText += "\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.";
  }
  if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
    promptText += `\n\nTarget duration: about ${Math.max(1, Math.round(req.durationSeconds))} seconds.`;
  }

  return {
    model,
    messages: [{ role: "user", content: promptText }],
    modalities: ["text", "audio"],
    stream: true,
    audio: {
      voice: "default",
      format: format ?? "mp3",
    },
  };
}

function detectAudioFormat(buffer: Buffer): { mimeType: string; ext: string } {
  // Check for WAV (RIFF header)
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return { mimeType: "audio/wav", ext: "wav" };
  }
  // Check for MP3 (MPEG sync or ID3 tag)
  if (
    buffer.length > 2 &&
    ((buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
      (buffer.length > 3 && buffer.toString("ascii", 0, 3) === "ID3"))
  ) {
    return { mimeType: "audio/mpeg", ext: "mp3" };
  }
  // Fallback to mp3 (OpenRouter's current default)
  return { mimeType: "audio/mpeg", ext: "mp3" };
}

export function buildOpenRouterMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [...SUPPORTED_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "openrouter", agentDir }),
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsDuration: true,
        supportsFormat: true,
        supportedFormats: [...SUPPORTED_FORMATS],
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("OpenRouter music generation does not support image reference inputs.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const { baseUrl, headers, allowPrivateNetwork, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg?.models?.providers?.openrouter?.request,
          ),
          provider: "openrouter",
          capability: "audio",
          transport: "http",
        });

      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "OpenRouter music generation",
      });

      const { audioBuffer, transcriptPieces } = await streamOpenRouterMusic({
        baseUrl,
        headers,
        body: buildMusicRequestBody(req, model, req.format),

        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      const { mimeType, ext } = detectAudioFormat(audioBuffer);
      const track: GeneratedMusicAsset = {
        buffer: audioBuffer,
        mimeType,
        fileName: `track-1.${ext}`,
      };

      const result: Awaited<ReturnType<MusicGenerationProvider["generateMusic"]>> = {
        tracks: [track],
        model,
        ...(transcriptPieces.length > 0 ? { lyrics: [transcriptPieces.join(" ").trim()] } : {}),
        metadata: {
          instrumental: req.instrumental === true,
          ...(typeof req.durationSeconds === "number"
            ? { requestedDurationSeconds: req.durationSeconds }
            : {}),
        },
      };

      return result;
    },
  };
}
