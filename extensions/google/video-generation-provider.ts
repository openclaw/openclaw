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
} from "./generation-provider-metadata.js";
import { resolveGoogleApiClientHeaders } from "./google-api-client-header.js";
import { createGoogleGenAI } from "./google-genai-runtime.js";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { resolveGoogleGenerativeAiApiOrigin } from "./provider-policy.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const GOOGLE_VIDEO_OPERATION_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE =
  "Google video generation response missing generated videos";
const GOOGLE_VIDEO_FILE_FAILED_MESSAGE = "Google generated video file processing failed";

type GoogleInteractionVideoContent = {
  data?: string;
  uri?: string;
  mime_type?: string;
};

type GoogleInteraction = {
  id?: string;
  output_video?: GoogleInteractionVideoContent;
};

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
}): "360p" | "720p" | "1080p" | "4k" | undefined {
  const direct = normalizeOptionalString(params.resolution)?.toLowerCase();
  if (direct === "360p" || direct === "720p" || direct === "1080p" || direct === "4k") {
    return direct;
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  const maxEdge = Math.max(parsedSize.width, parsedSize.height);
  if (maxEdge >= 3840) {
    return "4k";
  }
  if (maxEdge >= 1920) {
    return "1080p";
  }
  if (maxEdge >= 1280) {
    return "720p";
  }
  if (maxEdge >= 640) {
    return "360p";
  }
  return undefined;
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

type GoogleInteractionContent =
  | { type: "image"; data: string; mime_type: string }
  | { type: "video"; data: string; mime_type: string }
  | { type: "text"; text: string };

function buildGoogleInteractionInput(req: VideoGenerationRequest): GoogleInteractionContent[] {
  const contents: GoogleInteractionContent[] = [];
  for (const image of req.inputImages ?? []) {
    if (!image.buffer) {
      continue;
    }
    contents.push({
      type: "image",
      data: image.buffer.toString("base64"),
      mime_type: normalizeOptionalString(image.mimeType) || "image/png",
    });
  }
  for (const video of req.inputVideos ?? []) {
    if (!video.buffer) {
      continue;
    }
    contents.push({
      type: "video",
      data: video.buffer.toString("base64"),
      mime_type: normalizeOptionalString(video.mimeType) || "video/mp4",
    });
  }
  contents.push({ type: "text", text: req.prompt });
  return contents;
}

function extractGoogleVideoFileId(uri: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(uri);
  if (!trimmed) {
    return undefined;
  }
  const match = /files\/([^/:?#]+)/u.exec(trimmed);
  return match?.[1] || undefined;
}

function readGoogleVideoFileState(file: unknown): string | undefined {
  const state = (file as { state?: unknown } | undefined)?.state;
  return typeof state === "string" ? state : undefined;
}

export const googleVideoGenerationProvider: VideoGenerationProvider = {
  ...createGoogleVideoGenerationProviderMetadata(),
  async generateVideo(req) {
    if ((req.inputImages?.length ?? 0) > 2) {
      throw new Error("Google video generation supports at most two input images.");
    }
    if ((req.inputVideos?.length ?? 0) > 1) {
      throw new Error("Google video generation supports at most one input video.");
    }
    // Validate the requested duration even though the Omni Interactions API has
    // no duration parameter; the generated length is model-controlled.
    normalizeVideoGenerationDuration({ durationSeconds: req.durationSeconds });
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
    const model = normalizeOptionalString(req.model) || DEFAULT_GOOGLE_VIDEO_MODEL;
    const aspectRatio = resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size });
    const resolution = resolveResolution({ resolution: req.resolution, size: req.size });
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
    const interaction = (await executeProviderOperationWithRetry({
      provider: "google",
      stage: "create",
      operation: () =>
        client.interactions.create(
          {
            model: stripGoogleProviderPrefix(model),
            input: buildGoogleInteractionInput(req),
            response_format: {
              type: "video",
              ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
              ...(resolution ? { resolution } : {}),
              delivery: "uri",
            },
            background: false,
            store: false,
            stream: false,
          },
          {
            // Paid generation creation must stay single-shot: the SDK's default
            // retry policy would resubmit the billed request after lost
            // responses or transient 5xx. Retry ownership stays with the shared
            // operation wrapper, which does not retry the create stage.
            maxRetries: 0,
          },
        ),
    }).catch((error: unknown) => {
      throw redactGoogleVideoSdkError(error, authHeaders);
    })) as GoogleInteraction;

    const outputVideo = interaction.output_video;
    if (!outputVideo || (!outputVideo.data && !outputVideo.uri)) {
      throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
    }
    const maxVideoBytes = resolveGeneratedMediaMaxBytes(req.cfg, "video");
    const mimeType = normalizeOptionalString(outputVideo.mime_type) || "video/mp4";
    let video: GeneratedVideoAsset;
    if (outputVideo.data) {
      if (estimateBase64DecodedBytes(outputVideo.data) > maxVideoBytes) {
        throw new Error(`Google generated video download exceeds ${maxVideoBytes} bytes`);
      }
      const canonicalVideo = canonicalizeGoogleProviderBase64(outputVideo.data);
      if (!canonicalVideo) {
        throw new Error("Google video generation returned malformed base64 video data");
      }
      video = {
        buffer: Buffer.from(canonicalVideo, "base64"),
        mimeType,
        fileName: "video-1.mp4",
      };
    } else {
      const fileId = extractGoogleVideoFileId(outputVideo.uri);
      if (!fileId) {
        throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
      }
      const readState = async () =>
        requestGoogleVideoJson({
          url: `${restBaseUrl}/files/${fileId}`,
          method: "GET",
          headers: authHeaders,
          deadline,
          stage: "poll",
        });
      let file = await readState();
      for (let attempt = 0; readGoogleVideoFileState(file) !== "ACTIVE"; attempt += 1) {
        if (readGoogleVideoFileState(file) === "FAILED") {
          throw new Error(GOOGLE_VIDEO_FILE_FAILED_MESSAGE);
        }
        if (attempt >= MAX_POLL_ATTEMPTS) {
          throw new Error("Google video generation did not finish in time");
        }
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        file = await readState();
      }
      const downloadUrl = new URL(`${restBaseUrl}/files/${fileId}:download`);
      downloadUrl.searchParams.set("alt", "media");
      downloadUrl.searchParams.set("key", apiKey);
      const downloadLabel = "Google generated video download";
      const timeoutMs = resolveProviderOperationTimeoutMs({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      });
      video = await executeProviderOperationWithRetry({
        provider: "google",
        stage: "download",
        operation: async () => {
          const { response, release } = await fetchWithSsrFGuard({
            url: downloadUrl.toString(),
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
                  { "x-goog-api-key": apiKey },
                ),
              );
            }
            const buffer = await readProviderBinaryResponse(response, downloadLabel, "video", {
              maxBytes: maxVideoBytes,
              chunkTimeoutMs: timeoutMs,
              onOverflow: ({ maxBytes }) => new Error(`${downloadLabel} exceeds ${maxBytes} bytes`),
              onIdleTimeout: ({ chunkTimeoutMs }) =>
                new Error(`${downloadLabel} stalled after ${chunkTimeoutMs}ms`),
            });
            return {
              buffer,
              mimeType: normalizeOptionalString(response.headers.get("content-type")) || mimeType,
              fileName: "video-1.mp4",
            };
          } finally {
            await release();
          }
        },
      });
    }
    return {
      videos: [video],
      model,
      metadata: interaction.id ? { interactionId: interaction.id } : undefined,
    };
  },
};
