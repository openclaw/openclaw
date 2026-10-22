import {
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  createProviderOperationDeadline,
  executeProviderOperationWithRetry,
  readProviderBinaryResponse,
  readProviderJsonResponse,
  redactProviderResponseErrorText,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeVideoGenerationDuration,
  type GeneratedVideoAsset,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { canonicalizeGoogleProviderBase64 } from "./base64.js";
import { parseGeminiAuth } from "./gemini-auth.js";
import { resolveGoogleGenerationApiKey } from "./generation-auth.js";
import {
  createGoogleVideoGenerationProviderMetadata,
  DEFAULT_GOOGLE_VIDEO_MODEL,
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
} from "./generation-provider-metadata.js";
import { resolveGoogleApiClientHeaders } from "./google-api-client-header.js";
import { createGoogleGenAI, type GoogleGenAIClient } from "./google-genai-runtime.js";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { resolveGoogleGenerativeAiApiOrigin } from "./provider-policy.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const GOOGLE_VIDEO_OPERATION_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE =
  "Google video generation response missing generated videos";

function resolveGoogleVideoRestBaseUrl(configuredBaseUrl?: string): string {
  return `${configuredBaseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta`;
}

function parseVideoSize(size: string | undefined): { width: number; height: number } | undefined {
  const trimmed = normalizeOptionalString(size);
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
}

function resolveAspectRatio(params: {
  aspectRatio?: string;
  size?: string;
}): "16:9" | "9:16" | undefined {
  const direct = normalizeOptionalString(params.aspectRatio);
  if (direct === "16:9" || direct === "9:16") {
    return direct;
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  return parsedSize.width >= parsedSize.height ? "16:9" : "9:16";
}

function resolveResolution(params: {
  resolution?: string;
  size?: string;
}): "720p" | "1080p" | undefined {
  if (params.resolution === "720P") {
    return "720p";
  }
  if (params.resolution === "1080P") {
    return "1080p";
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  const maxEdge = Math.max(parsedSize.width, parsedSize.height);
  return maxEdge >= 1920 ? "1080p" : maxEdge >= 1280 ? "720p" : undefined;
}

function resolveInputImage(req: VideoGenerationRequest) {
  const input = req.inputImages?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    imageBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "image/png",
  };
}

function resolveInputVideo(req: VideoGenerationRequest) {
  const input = req.inputVideos?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    videoBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "video/mp4",
  };
}

function resolveGoogleGeneratedVideoFileDownloadUrl(params: {
  file: unknown;
  apiKey: string;
  configuredBaseUrl?: string;
}): string | undefined {
  const resource = params.file as { name?: unknown; uri?: unknown } | undefined;
  const name = normalizeOptionalString(resource?.name) ?? normalizeOptionalString(resource?.uri);
  if (!name || !/^files\/[^/?#]+$/u.test(name)) {
    return undefined;
  }
  const baseUrl = resolveGoogleVideoRestBaseUrl(params.configuredBaseUrl);
  const url = new URL(`${baseUrl}/${name}:download`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("key", params.apiKey);
  return url.toString();
}

function extractGoogleApiErrorCode(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") {
    return status;
  }
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { code?: unknown; error?: { code?: unknown } };
    const code = typeof parsed.code === "number" ? parsed.code : parsed.error?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return /\b404\b/u.test(message) ? 404 : undefined;
  }
}

function extractGeneratedVideos(operation: unknown): Array<{ video?: unknown }> {
  const response = (operation as { response?: Record<string, unknown> }).response;
  const generatedVideos = response?.generatedVideos;
  if (Array.isArray(generatedVideos) && generatedVideos.length > 0) {
    return generatedVideos as Array<{ video?: unknown }>;
  }
  const generatedSamples = (response?.generateVideoResponse as { generatedSamples?: unknown })
    ?.generatedSamples;
  return Array.isArray(generatedSamples) ? (generatedSamples as Array<{ video?: unknown }>) : [];
}

function redactGoogleVideoSdkError(error: unknown, headers: Record<string, string>): Error {
  // Preserve diagnostic metadata without retaining credential-bearing SDK causes or responses.
  const safeError = new Error(redactProviderResponseErrorText(formatErrorMessage(error), headers));
  safeError.name = redactProviderResponseErrorText(readErrorName(error) || "Error", headers);
  const code = extractErrorCode(error);
  Object.assign(safeError, {
    status: extractGoogleApiErrorCode(error),
    ...(code ? { code: redactProviderResponseErrorText(code, headers) } : {}),
  });
  return safeError;
}

async function requestGoogleVideoJson(params: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  stage: "create" | "poll";
  body?: unknown;
}): Promise<unknown> {
  function createHttpError(response: Response, detail: unknown): Error {
    const parts = [`HTTP ${response.status}`];
    const statusText = response.statusText.trim();
    if (statusText) {
      parts.push(statusText);
    }
    if (typeof detail === "string") {
      const trimmed = detail.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    } else if (detail && typeof detail === "object") {
      parts.push(JSON.stringify(detail));
    }
    const error = new Error(redactProviderResponseErrorText(parts.join(": "), params.headers));
    Object.assign(error, { status: response.status, statusCode: response.status });
    return error;
  }

  return await executeProviderOperationWithRetry({
    provider: "google",
    stage: params.stage,
    operation: async () => {
      const { response, release } = await fetchWithSsrFGuard({
        url: params.url,
        init: {
          method: params.method,
          headers: params.headers,
          ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
        },
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline: params.deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      });
      try {
        if (!response.ok) {
          const text = new TextDecoder().decode(
            await readResponseWithLimit(response, GOOGLE_VIDEO_OPERATION_RESPONSE_MAX_BYTES, {
              onOverflow: ({ maxBytes }) =>
                new Error(`Google video operation response exceeds ${maxBytes} bytes`),
            }),
          );
          let detail: unknown = text;
          if (text) {
            try {
              detail = JSON.parse(text) as unknown;
            } catch {
              detail = text;
            }
          }
          throw createHttpError(response, detail);
        }
        return await readProviderJsonResponse(response, "Google video operation response", {
          maxBytes: GOOGLE_VIDEO_OPERATION_RESPONSE_MAX_BYTES,
          requestHeaders: params.headers,
        });
      } finally {
        await release();
      }
    },
  });
}

export const googleVideoGenerationProvider: VideoGenerationProvider = {
  ...createGoogleVideoGenerationProviderMetadata(),
  async generateVideo(req) {
    if ((req.inputImages?.length ?? 0) > 1) {
      throw new Error("Google video generation supports at most one input image.");
    }
    if ((req.inputVideos?.length ?? 0) > 1) {
      throw new Error("Google video generation supports at most one input video.");
    }
    if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
      throw new Error("Google video generation does not support image and video inputs together.");
    }
    const apiKey = await resolveGoogleGenerationApiKey(req);

    const configuredUrl = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
    const configuredBaseUrl = configuredUrl
      ? resolveGoogleGenerativeAiApiOrigin(configuredUrl)
      : undefined;
    const restBaseUrl = resolveGoogleVideoRestBaseUrl(configuredBaseUrl);
    const authHeaders = {
      ...parseGeminiAuth(apiKey).headers,
      ...resolveGoogleApiClientHeaders({
        baseUrl: restBaseUrl,
        api: "google-generative-ai",
        capability: "video",
        transport: "http",
      }),
    };
    const durationSeconds = normalizeVideoGenerationDuration({
      durationSeconds: req.durationSeconds,
      supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
    });
    const model = normalizeOptionalString(req.model) || DEFAULT_GOOGLE_VIDEO_MODEL;
    const aspectRatio = resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size });
    const resolution = resolveResolution({ resolution: req.resolution, size: req.size });
    const hasReferenceInputs =
      (req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0;
    const deadline = createProviderOperationDeadline({
      timeoutMs: req.timeoutMs,
      label: "Google video generation",
    });
    const client = createGoogleGenAI({
      apiKey,
      httpOptions: {
        ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
        timeout: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      },
    });
    const generateViaRest = async (): Promise<unknown> => {
      const prompt = req.prompt;
      const id = stripGoogleProviderPrefix(
        normalizeOptionalString(model) || DEFAULT_GOOGLE_VIDEO_MODEL,
      );
      const modelPath = id.startsWith("models/") ? id : `models/${id}`;
      let restOperation = await requestGoogleVideoJson({
        url: `${restBaseUrl}/${modelPath}:predictLongRunning`,
        method: "POST",
        headers: authHeaders,
        deadline,
        stage: "create",
        body: {
          instances: [{ prompt }],
          parameters: {
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
          },
        },
      });

      for (let attempt = 0; !((restOperation as { done?: boolean }).done ?? false); attempt += 1) {
        if (attempt >= MAX_POLL_ATTEMPTS) {
          throw new Error("Google video generation did not finish in time");
        }
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        const operationName = (restOperation as { name?: unknown }).name;
        if (typeof operationName !== "string" || !operationName) {
          throw new Error("Google video operation response missing name for polling");
        }
        restOperation = await requestGoogleVideoJson({
          url: `${restBaseUrl}/${operationName}`,
          method: "GET",
          headers: authHeaders,
          deadline,
          stage: "poll",
        });
      }
      const error = (restOperation as { error?: unknown }).error;
      if (error) {
        throw new Error(redactProviderResponseErrorText(JSON.stringify(error), authHeaders));
      }
      return restOperation;
    };
    let usedRestFallback = false;
    let operation;
    try {
      operation = await client.models.generateVideos({
        model: stripGoogleProviderPrefix(model),
        prompt: req.prompt,
        image: resolveInputImage(req),
        video: resolveInputVideo(req),
        config: {
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(resolution ? { resolution } : {}),
        },
      });
    } catch (error) {
      if (hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404) {
        throw redactGoogleVideoSdkError(error, authHeaders);
      }
      usedRestFallback = true;
      operation = await generateViaRest();
    }

    if (!usedRestFallback) {
      let sdkOperation = operation as Awaited<
        ReturnType<GoogleGenAIClient["models"]["generateVideos"]>
      >;
      for (let attempt = 0; !(sdkOperation.done ?? false); attempt += 1) {
        if (attempt >= MAX_POLL_ATTEMPTS) {
          throw new Error("Google video generation did not finish in time");
        }
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
        sdkOperation = await executeProviderOperationWithRetry({
          provider: "google",
          stage: "poll",
          operation: () => client.operations.getVideosOperation({ operation: sdkOperation }),
        }).catch((error: unknown) => {
          throw redactGoogleVideoSdkError(error, authHeaders);
        });
      }
      if (sdkOperation.error) {
        throw new Error(
          redactProviderResponseErrorText(JSON.stringify(sdkOperation.error), authHeaders),
        );
      }
      operation = sdkOperation;
    }
    const generatedVideos = extractGeneratedVideos(operation);
    if (generatedVideos.length === 0) {
      throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
    }
    const finalOperation = operation as { name?: string };
    const maxVideoBytes = resolveGeneratedMediaMaxBytes(req.cfg, "video");
    const videos = await Promise.all(
      generatedVideos.map(async (entry, index) => {
        const inline = entry.video as
          | { videoBytes?: string; uri?: string; mimeType?: string }
          | undefined;
        if (inline?.videoBytes) {
          if (estimateBase64DecodedBytes(inline.videoBytes) > maxVideoBytes) {
            throw new Error(`Google generated video download exceeds ${maxVideoBytes} bytes`);
          }
          const canonicalVideo = canonicalizeGoogleProviderBase64(inline.videoBytes);
          if (!canonicalVideo) {
            throw new Error("Google video generation returned malformed base64 video data");
          }
          const buffer = Buffer.from(canonicalVideo, "base64");
          return {
            buffer,
            mimeType: normalizeOptionalString(inline.mimeType) || "video/mp4",
            fileName: `video-${index + 1}.mp4`,
          };
        }
        const download = async (
          uri: string | undefined,
        ): Promise<GeneratedVideoAsset | undefined> => {
          const mimeType = inline?.mimeType;
          const timeoutMs = resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          });
          const trimmed = normalizeOptionalString(uri);
          if (!trimmed) {
            return undefined;
          }
          const url = URL.parse(trimmed);
          if (url?.protocol !== "https:") {
            return undefined;
          }
          const allowedOrigins = new Set(["https://generativelanguage.googleapis.com"]);
          const configuredOrigin = URL.parse(configuredBaseUrl ?? "")?.origin;
          if (configuredOrigin?.startsWith("https://")) {
            allowedOrigins.add(configuredOrigin);
          }
          if (!allowedOrigins.has(url.origin)) {
            return undefined;
          }
          if (!url.searchParams.has("key")) {
            url.searchParams.set("key", apiKey);
          }
          const downloadUrl = url.toString();
          return await executeProviderOperationWithRetry({
            provider: "google",
            stage: "download",
            operation: async () => {
              const { response, release } = await fetchWithSsrFGuard({
                url: downloadUrl,
                timeoutMs,
              });
              try {
                if (!response.ok) {
                  // A debug-capture clone can keep the tee open, so waiting for cancel
                  // would hang before the HTTP error and dispatcher can be released.
                  void response.body?.cancel().catch(() => undefined);
                  throw new Error(
                    redactProviderResponseErrorText(
                      `Failed to download Google generated video: ${response.status} ${response.statusText}`,
                      { "x-goog-api-key": url.searchParams.get("key") ?? apiKey },
                    ),
                  );
                }
                const downloadLabel = "Google generated video download";
                const buffer = await readProviderBinaryResponse(response, downloadLabel, "video", {
                  maxBytes: maxVideoBytes,
                  chunkTimeoutMs: timeoutMs,
                  onOverflow: ({ maxBytes }) =>
                    new Error(`${downloadLabel} exceeds ${maxBytes} bytes`),
                  onIdleTimeout: ({ chunkTimeoutMs }) =>
                    new Error(`${downloadLabel} stalled after ${chunkTimeoutMs}ms`),
                });
                return {
                  buffer,
                  mimeType:
                    normalizeOptionalString(response.headers.get("content-type")) ||
                    normalizeOptionalString(mimeType) ||
                    "video/mp4",
                  fileName: `video-${index + 1}.mp4`,
                };
              } finally {
                await release();
              }
            },
          });
        };
        const directDownload = await download(inline?.uri);
        if (directDownload) {
          return directDownload;
        }
        if (!inline) {
          throw new Error("Google generated video missing file handle");
        }
        const fileDownload = await download(
          resolveGoogleGeneratedVideoFileDownloadUrl({
            file: inline,
            apiKey,
            configuredBaseUrl,
          }),
        );
        if (!fileDownload) {
          throw new Error("Google generated video missing bounded download URL");
        }
        return fileDownload;
      }),
    );
    return {
      videos,
      model,
      metadata: finalOperation.name
        ? {
            operationName: finalOperation.name,
          }
        : undefined,
    };
  },
};
