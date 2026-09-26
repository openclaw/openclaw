import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
// Google provider module implements model/runtime integration.
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { generatedMusicAssetFromBase64 } from "openclaw/plugin-sdk/music-generation";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleGenerativeAiApiOrigin } from "./api.js";
import { toStandardGoogleProviderBase64 } from "./base64.js";
import {
  createGoogleMusicGenerationProviderMetadata,
  DEFAULT_GOOGLE_MUSIC_MODEL,
  GOOGLE_MAX_INPUT_IMAGES,
  GOOGLE_PRO_MUSIC_MODEL,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";

const DEFAULT_TIMEOUT_MS = 180_000;

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateMusicResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
};

function resolveConfiguredGoogleMusicBaseUrl(req: MusicGenerationRequest): string | undefined {
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
  return configured ? resolveGoogleGenerativeAiApiOrigin(configured) : undefined;
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

function resolveSupportedFormats(model: string): readonly string[] {
  return model === GOOGLE_PRO_MUSIC_MODEL ? ["mp3", "wav"] : ["mp3"];
}

function resolveTrackFileName(params: { index: number; mimeType: string; model: string }): string {
  const ext =
    extensionForMime(params.mimeType)?.replace(/^\./u, "") ||
    (params.model === GOOGLE_PRO_MUSIC_MODEL ? "wav" : "mp3");
  return `track-${params.index + 1}.${ext}`;
}

function extractTracks(params: { payload: GoogleGenerateMusicResponse; model: string }): {
  tracks: GeneratedMusicAsset[];
  lyrics: string[];
} {
  const lyrics: string[] = [];
  const tracks: GeneratedMusicAsset[] = [];
  for (const candidate of params.payload.candidates ?? []) {
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
      tracks.push(
        generatedMusicAssetFromBase64({
          base64: standardAudio,
          mimeType,
          fileName: resolveTrackFileName({
            index: tracks.length,
            mimeType,
            model: params.model,
          }),
        }),
      );
    }
  }
  return { tracks, lyrics };
}

function resolveTerminalNoAudioReason(payload: GoogleGenerateMusicResponse): string | undefined {
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

export function buildGoogleMusicGenerationProvider(): MusicGenerationProvider {
  return {
    ...createGoogleMusicGenerationProviderMetadata(),
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > GOOGLE_MAX_INPUT_IMAGES) {
        throw new Error(
          `Google music generation supports at most ${GOOGLE_MAX_INPUT_IMAGES} reference images.`,
        );
      }
      // Credential preparation (OAuth refresh, profile lock) shares the request's
      // timeout budget, so the abort signal must cover it — not only the HTTP call.
      // Only requests that explicitly configure a timeout get credential abort
      // coverage; an omitted timeout keeps the existing behavior (no absolute
      // deadline on credential preparation, only the per-request DEFAULT_TIMEOUT_MS
      // fallback used by the HTTP/SDK layer).
      //
      // Timeout contract:
      // - Explicit timeout: one deadline is created before credential lookup so
      //   the abort signal and the SDK deadline share the same budget; each SDK
      //   attempt receives only the remaining time, not a fresh full timeout.
      // - Omitted timeout: the deadline is created after credential lookup
      //   (matching main) with DEFAULT_TIMEOUT_MS, preserving the shared 180-second
      //   retry ceiling so a no-audio retry cannot each take a full default budget.
      const hasExplicitTimeout = typeof req.timeoutMs === "number";
      const { signal, cleanup } = buildTimeoutAbortSignal({
        timeoutMs: req.timeoutMs,
        operation: "Google music generation",
      });
      try {
        signal?.throwIfAborted();
        const explicitDeadline = hasExplicitTimeout
          ? createProviderOperationDeadline({
              timeoutMs: req.timeoutMs,
              label: "Google music generation",
            })
          : undefined;
        const auth = await resolveApiKeyForProvider({
          provider: "google",
          cfg: req.cfg,
          agentDir: req.agentDir,
          store: req.authStore,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!auth.apiKey) {
          throw new Error("Google API key missing");
        }

        const deadline =
          explicitDeadline ??
          createProviderOperationDeadline({
            timeoutMs: DEFAULT_TIMEOUT_MS,
            label: "Google music generation",
          });

        const model = normalizeOptionalString(req.model) || DEFAULT_GOOGLE_MUSIC_MODEL;
        if (req.format) {
          const supportedFormats = resolveSupportedFormats(model);
          if (!supportedFormats.includes(req.format)) {
            throw new Error(
              `Google music generation model ${model} supports ${supportedFormats.join(", ")} output.`,
            );
          }
        }

        const configuredBaseUrl = resolveConfiguredGoogleMusicBaseUrl(req);
        let generated: ReturnType<typeof extractTracks> | undefined;
        // Lyria promises audio for successful Clip responses, but has returned
        // unblocked text-only payloads transiently. Never retry explicit stops.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = createGoogleGenAI({
            apiKey: auth.apiKey,
            httpOptions: {
              ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
              timeout: resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              }),
            },
          });
          const response = (await client.models.generateContent({
            model,
            contents: [
              { text: buildMusicPrompt(req) },
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
          })) as GoogleGenerateMusicResponse;
          generated = extractTracks({ payload: response, model });
          if (generated.tracks.length > 0) {
            break;
          }
          const terminalReason = resolveTerminalNoAudioReason(response);
          if (terminalReason) {
            throw new Error(`Google music generation returned no audio: ${terminalReason}`);
          }
        }
        if (!generated || generated.tracks.length === 0) {
          throw new Error("Google music generation response missing audio data");
        }
        const { tracks, lyrics } = generated;
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
      } finally {
        cleanup();
      }
    },
  };
}
