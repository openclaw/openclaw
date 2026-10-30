import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import {
  downloadGeneratedMusicAsset,
  type GeneratedMusicAsset,
  type MusicGenerationProvider,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutError,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertMinimaxBaseResp,
  normalizeMinimaxHexAudio,
  fetchMinimaxResponse,
  resolveMinimaxMediaRequestConfig,
  type MinimaxBaseResp,
  type MinimaxRequestPolicy,
} from "./media-provider-runtime.js";

const DEFAULT_MINIMAX_MUSIC_MODEL = "music-2.6";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const STREAM_ENVELOPE_MAX_BYTES_MULTIPLIER = 5;
const STREAM_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

function decodeHexAudioWithLimit(data: string, maxBytes: number): Buffer {
  const trimmed = normalizeMinimaxHexAudio(data, "MiniMax music generation");
  if (trimmed.length / 2 > maxBytes) {
    throw createGeneratedMusicTooLargeError(maxBytes);
  }
  return Buffer.from(trimmed, "hex");
}

function decodePossibleText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex").toString("utf8").trim();
  }
  return trimmed;
}

function createGeneratedMusicTooLargeError(maxBytes: number): Error {
  return new Error(`MiniMax generated music download exceeds ${maxBytes} bytes`);
}

function resolveStreamEnvelopeMaxBytes(maxBytes: number): number {
  return Math.max(
    STREAM_ENVELOPE_OVERHEAD_BYTES,
    maxBytes * STREAM_ENVELOPE_MAX_BYTES_MULTIPLIER + STREAM_ENVELOPE_OVERHEAD_BYTES,
  );
}

export function buildMinimaxMusicGenerationProvider(
  providerId = "minimax",
): MusicGenerationProvider {
  return {
    id: providerId,
    label: "MiniMax",
    defaultModel: DEFAULT_MINIMAX_MUSIC_MODEL,
    models: [DEFAULT_MINIMAX_MUSIC_MODEL, "music-2.6-free", "music-cover", "music-cover-free"],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: providerId, ...ctx }),
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        supportsFormat: true,
        supportedFormats: ["mp3"],
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("MiniMax music generation does not support image reference inputs.");
      }
      const requestedLyrics = normalizeOptionalString(req.lyrics);
      if (req.instrumental === true && requestedLyrics) {
        throw new Error("MiniMax music generation cannot use lyrics when instrumental=true.");
      }
      if (req.format && req.format !== "mp3") {
        throw new Error("MiniMax music generation currently supports mp3 output only.");
      }

      const operationTimeoutMs = req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveMinimaxMediaRequestConfig({
          cfg: req.cfg,
          providerId,
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "audio",
        });
      const deadline = createProviderOperationDeadline({
        timeoutMs: operationTimeoutMs,
        label: "MiniMax music generation",
      });
      const requestPolicy: MinimaxRequestPolicy = { allowPrivateNetwork, dispatcherPolicy };
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MINIMAX_MUSIC_MODEL;
      const body = {
        model,
        prompt: req.prompt.trim(),
        ...(req.instrumental === true ? { is_instrumental: true } : {}),
        ...(requestedLyrics
          ? { lyrics: requestedLyrics }
          : req.instrumental === true
            ? {}
            : { lyrics_optimizer: true }),
        stream: true,
        output_format: "hex",
        audio_setting: {
          sample_rate: 44_100,
          bitrate: 256_000,
          format: "mp3",
        },
      };

      const { response: res, release } = await postJsonRequest({
        url: `${baseUrl}/v1/music_generation`,
        headers: jsonHeaders,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: operationTimeoutMs,
        }),
        fetchFn: fetch,
        pinDns: false,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(res, "MiniMax music generation failed");
        const responseContentType = normalizeOptionalString(res.headers.get("content-type")) ?? "";
        const lowerContentType = responseContentType.toLowerCase();
        const maxGeneratedMusicBytes = resolveGeneratedMediaMaxBytes(req.cfg, "audio");

        async function readResponseBufferWithDeadline(
          response: Response,
          maxBytes: number,
        ): Promise<Buffer> {
          return await readResponseWithLimit(response, maxBytes, {
            timeoutMs: () =>
              resolveProviderOperationTimeoutMs({
                deadline,
                defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
              }),
            onTimeout: () => createProviderOperationTimeoutError(deadline),
            onOverflow: ({ maxBytes: limit }) => createGeneratedMusicTooLargeError(limit),
          });
        }

        async function readStreamingTrack(): Promise<GeneratedMusicAsset> {
          const contentType = normalizeOptionalString(res.headers.get("content-type")) ?? "";
          if (contentType.toLowerCase().startsWith("audio/")) {
            const ext = extensionForMime(contentType)?.replace(/^\./u, "") || "mp3";
            return {
              buffer: await readResponseBufferWithDeadline(res, maxGeneratedMusicBytes),
              mimeType: contentType,
              fileName: `track-1.${ext}`,
            };
          }
          const chunks: Buffer[] = [];
          let decodedBytes = 0;
          let completed = false;
          const text = new TextDecoder().decode(
            await readResponseBufferWithDeadline(
              res,
              resolveStreamEnvelopeMaxBytes(maxGeneratedMusicBytes),
            ),
          );
          for (const rawLine of text.split(/\r?\n/u)) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) {
              continue;
            }
            const json = line.slice("data:".length).trim();
            if (!json || json === "[DONE]") {
              continue;
            }
            const frame = JSON.parse(json) as {
              data?: {
                audio?: string;
                status?: number | string;
              };
              base_resp?: MinimaxBaseResp;
            };
            assertMinimaxBaseResp(frame.base_resp, "MiniMax music generation failed");
            if (String(frame.data?.status ?? "") === "2") {
              completed = true;
              if (chunks.length > 0) {
                continue;
              }
            }
            const audio = normalizeOptionalString(frame.data?.audio);
            if (audio) {
              const chunk = decodeHexAudioWithLimit(audio, maxGeneratedMusicBytes - decodedBytes);
              chunks.push(chunk);
              decodedBytes += chunk.byteLength;
            }
          }
          if (!completed) {
            throw new Error("MiniMax music generation stream ended without completion");
          }
          const buffer = Buffer.concat(chunks);
          if (buffer.byteLength === 0) {
            throw new Error("MiniMax music generation response missing audio output");
          }
          return {
            buffer,
            mimeType: "audio/mpeg",
            fileName: "track-1.mp3",
          };
        }

        const payload =
          lowerContentType.includes("text/event-stream") || lowerContentType.startsWith("audio/")
            ? null
            : (JSON.parse(
                new TextDecoder().decode(
                  await readResponseBufferWithDeadline(
                    res.clone(),
                    resolveStreamEnvelopeMaxBytes(maxGeneratedMusicBytes),
                  ),
                ),
              ) as {
                task_id?: string;
                audio?: string;
                audio_url?: string;
                lyrics?: string;
                data?: {
                  audio?: string;
                  audio_url?: string;
                  lyrics?: string;
                };
                base_resp?: MinimaxBaseResp;
              });
        if (payload) {
          assertMinimaxBaseResp(payload.base_resp, "MiniMax music generation failed");
        }

        const audioCandidate =
          normalizeOptionalString(payload?.audio) ?? normalizeOptionalString(payload?.data?.audio);
        const audioCandidateIsUrl = Boolean(
          audioCandidate && /^https?:\/\//iu.test(audioCandidate),
        );
        const audioUrl =
          normalizeOptionalString(payload?.audio_url) ||
          normalizeOptionalString(payload?.data?.audio_url) ||
          (audioCandidateIsUrl ? audioCandidate : undefined);
        const inlineAudio = audioCandidateIsUrl ? undefined : audioCandidate;
        const responseLyrics = decodePossibleText(payload?.lyrics ?? payload?.data?.lyrics ?? "");
        const taskId = normalizeOptionalString(payload?.task_id);

        const track = audioUrl
          ? await downloadGeneratedMusicAsset({
              candidate: { url: audioUrl },
              timeoutMs:
                resolveProviderOperationTimeoutMs({
                  deadline,
                  defaultTimeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                }) ?? DEFAULT_TIMEOUT_MS,
              fetchFn: fetch,
              provider: "MiniMax",
              requestFailedMessage: "MiniMax generated music download failed",
              maxBytes: maxGeneratedMusicBytes,
              validateBinaryResponse: true,
              includeSourceUrl: false,
              fetchResponse: async ({ timeoutMs }) => {
                const result = await fetchMinimaxResponse({
                  stage: "download",
                  url: audioUrl,
                  init: { method: "GET" },
                  timeoutMs,
                  requestFailedMessage: "MiniMax generated music download failed",
                  policy: requestPolicy,
                });
                return {
                  ...result,
                  mimeType:
                    normalizeOptionalString(result.response.headers.get("content-type")) ??
                    "audio/mpeg",
                };
              },
            })
          : inlineAudio
            ? {
                buffer: decodeHexAudioWithLimit(inlineAudio, maxGeneratedMusicBytes),
                mimeType: "audio/mpeg",
                fileName: "track-1.mp3",
              }
            : await readStreamingTrack();
        return {
          tracks: [track],
          ...(responseLyrics ? { lyrics: [responseLyrics] } : {}),
          model,
          metadata: {
            ...(taskId ? { taskId } : {}),
            ...(audioUrl ? { audioUrl } : {}),
            instrumental: req.instrumental === true,
            ...(requestedLyrics ? { requestedLyrics: true } : {}),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
