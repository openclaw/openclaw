// Google provider module implements model/runtime integration.
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  executeProviderOperationWithRetry,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  parseGeminiAuth,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleVertexProject,
  resolveGoogleVertexLocation,
  buildGoogleVertexHeaders,
} from "./api.js";
import {
  createGoogleVideoGenerationProviderMetadata,
  DEFAULT_GOOGLE_VIDEO_MODEL,
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
  GOOGLE_VIDEO_MAX_DURATION_SECONDS,
  GOOGLE_VIDEO_MIN_DURATION_SECONDS,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI, type GoogleGenAIClient } from "./google-genai-runtime.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE =
  "Google video generation response missing generated videos";

function resolveConfiguredGoogleVideoBaseUrl(req: VideoGenerationRequest): string | undefined {
  const providerKey = req.provider === "google-vertex" ? "google-vertex" : "google";
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.[providerKey]?.baseUrl);
  return configured ? resolveGoogleGenerativeAiApiOrigin(configured) : undefined;
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

function assertGeneratedVideoBufferWithinLimit(buffer: Buffer, maxBytes: number): void {
  if (buffer.length > maxBytes) {
    throw new Error(`Google generated video download exceeds ${maxBytes} bytes`);
  }
}

function resolveGoogleVideoRestBaseUrl(
  isVertex: boolean,
  configuredBaseUrl?: string,
  vertexConfig?: { project: string; location: string },
): string {
  if (isVertex && vertexConfig) {
    const origin = configuredBaseUrl
      ? resolveGoogleGenerativeAiApiOrigin(configuredBaseUrl)
      : `https://${vertexConfig.location}-aiplatform.googleapis.com`;
    return `${origin}/v1/projects/${encodeURIComponent(vertexConfig.project)}/locations/${encodeURIComponent(vertexConfig.location)}/publishers/google`;
  }
  return `${configuredBaseUrl ? resolveGoogleGenerativeAiApiOrigin(configuredBaseUrl) : "https://generativelanguage.googleapis.com"}/v1beta`;
}

function resolveGoogleVideoRestModelPath(model: string, isVertex: boolean): string {
  const trimmed = normalizeOptionalString(model) || DEFAULT_GOOGLE_VIDEO_MODEL;
  if (isVertex) {
    if (trimmed.startsWith("models/")) {
      return trimmed;
    }
    if (trimmed.startsWith("google/models/")) {
      return trimmed.slice("google/".length);
    }
    if (trimmed.startsWith("google/")) {
      return `models/${trimmed.slice("google/".length)}`;
    }
    return `models/${trimmed}`;
  }

  if (trimmed.startsWith("google/models/")) {
    return trimmed.slice("google/".length);
  }
  if (trimmed.startsWith("models/")) {
    return trimmed;
  }
  if (trimmed.startsWith("google/")) {
    return `models/${trimmed.slice("google/".length)}`;
  }
  return `models/${trimmed}`;
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

function resolveDurationSeconds(durationSeconds: number | undefined): number | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.min(
    GOOGLE_VIDEO_MAX_DURATION_SECONDS,
    Math.max(GOOGLE_VIDEO_MIN_DURATION_SECONDS, Math.round(durationSeconds)),
  );
  return GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
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

function resolveGoogleGeneratedVideoDownloadUrl(params: {
  uri: string | undefined;
  apiKey: string;
  configuredBaseUrl?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.uri);
  if (!trimmed) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const allowedOrigins = new Set(["https://generativelanguage.googleapis.com"]);
  if (params.configuredBaseUrl) {
    try {
      const configuredOrigin = new URL(params.configuredBaseUrl).origin;
      if (configuredOrigin.startsWith("https://")) {
        allowedOrigins.add(configuredOrigin);
      }
    } catch {
      // Ignore invalid configured origins; resolveConfiguredGoogleVideoBaseUrl already normalizes.
    }
  }
  if (!allowedOrigins.has(url.origin)) {
    return undefined;
  }
  if (!url.searchParams.has("key")) {
    url.searchParams.set("key", params.apiKey);
  }
  return url.toString();
}

function resolveGoogleGeneratedVideoFileDownloadUrl(params: {
  file: unknown;
  apiKey: string;
  configuredBaseUrl?: string;
  isVertex?: boolean;
  vertexConfig?: { project: string; location: string };
}): string | undefined {
  const resource = params.file as { name?: unknown; uri?: unknown } | undefined;
  const name = normalizeOptionalString(resource?.name) ?? normalizeOptionalString(resource?.uri);
  if (!name || !/^files\/[^/?#]+$/u.test(name)) {
    return undefined;
  }
  const baseUrl = resolveGoogleVideoRestBaseUrl(
    params.isVertex ?? false,
    params.configuredBaseUrl,
    params.vertexConfig,
  );
  const url = new URL(`${baseUrl}/${name}:download`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("key", params.apiKey);
  return url.toString();
}

async function downloadGeneratedVideoFromUri(params: {
  uri: string | undefined;
  apiKey: string;
  configuredBaseUrl?: string;
  mimeType?: string;
  index: number;
  maxBytes: number;
  timeoutMs: number;
}): Promise<GeneratedVideoAsset | undefined> {
  const downloadUrl = resolveGoogleGeneratedVideoDownloadUrl({
    uri: params.uri,
    apiKey: params.apiKey,
    configuredBaseUrl: params.configuredBaseUrl,
  });
  if (!downloadUrl) {
    return undefined;
  }
  return await executeProviderOperationWithRetry({
    provider: "google",
    stage: "download",
    operation: async () => {
      const { response, release } = await fetchWithSsrFGuard({
        url: downloadUrl,
        timeoutMs: params.timeoutMs,
      });
      try {
        if (!response.ok) {
          throw new Error(
            `Failed to download Google generated video: ${response.status} ${response.statusText}`,
          );
        }
        const buffer = await readResponseWithLimit(response, params.maxBytes, {
          chunkTimeoutMs: params.timeoutMs,
          onOverflow: ({ maxBytes }) =>
            new Error(`Google generated video download exceeds ${maxBytes} bytes`),
          onIdleTimeout: ({ chunkTimeoutMs }) =>
            new Error(`Google generated video download stalled after ${chunkTimeoutMs}ms`),
        });
        return {
          buffer,
          mimeType:
            normalizeOptionalString(response.headers.get("content-type")) ||
            normalizeOptionalString(params.mimeType) ||
            "video/mp4",
          fileName: `video-${params.index + 1}.mp4`,
        };
      } finally {
        await release();
      }
    },
  });
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

  const vertexVideos = response?.videos;
  if (Array.isArray(vertexVideos) && vertexVideos.length > 0) {
    // Maps vertex format { bytesBase64Encoded: ... } back to common internal structure { videoBytes: ... }
    return vertexVideos.map((v) => ({
      video: {
        videoBytes: (v as { bytesBase64Encoded?: string }).bytesBase64Encoded,
        mimeType: (v as { mimeType?: string }).mimeType,
      },
    }));
  }

  const generatedVideos = response?.generatedVideos;
  if (Array.isArray(generatedVideos) && generatedVideos.length > 0) {
    return generatedVideos as Array<{ video?: unknown }>;
  }
  const generatedSamples = (response?.generateVideoResponse as { generatedSamples?: unknown })
    ?.generatedSamples;
  return Array.isArray(generatedSamples) ? (generatedSamples as Array<{ video?: unknown }>) : [];
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
    const error = new Error(parts.join(": "));
    Object.assign(error, { status: response.status, statusCode: response.status });
    return error;
  }

  return await executeProviderOperationWithRetry({
    provider: "google",
    stage: params.stage,
    operation: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => {
          const error = new Error("request timed out");
          error.name = "TimeoutError";
          controller.abort(error);
        },
        resolveProviderOperationTimeoutMs({
          deadline: params.deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      );
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: params.url,
          init: {
            method: params.method,
            headers: params.headers,
            ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
          },
          signal: controller.signal,
        });
        try {
          const text = await response.text();
          if (!response.ok) {
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
          const payload = text ? (JSON.parse(text) as unknown) : {};
          return payload;
        } finally {
          await release();
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

async function generateGoogleVideoViaRest(params: {
  baseUrl: string;
  headers: Record<string, string>;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  isVertex?: boolean;
}): Promise<unknown> {
  let operation = await requestGoogleVideoJson({
    url: params.isVertex
      ? `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model, true)}:predictLongRunning`
      : `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model, false)}:predictLongRunning`,
    method: "POST",
    headers: params.headers,
    deadline: params.deadline,
    stage: "create",
    body: {
      instances: [{ prompt: params.prompt }],
      parameters: {
        ...(typeof params.durationSeconds === "number"
          ? { durationSeconds: params.durationSeconds }
          : {}),
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
      },
    },
  });

  for (let attempt = 0; !((operation as { done?: boolean }).done ?? false); attempt += 1) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new Error("Google video generation did not finish in time");
    }
    await waitProviderOperationPollInterval({
      deadline: params.deadline,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const operationName = (operation as { name?: unknown }).name;
    if (typeof operationName !== "string" || !operationName) {
      throw new Error("Google video operation response missing name for polling");
    }

    if (params.isVertex) {
      operation = await requestGoogleVideoJson({
        url: `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model, true)}:fetchPredictOperation`,
        method: "POST",
        headers: params.headers,
        deadline: params.deadline,
        stage: "poll",
        body: { operationName },
      });
    } else {
      operation = await requestGoogleVideoJson({
        url: `${params.baseUrl}/${operationName}`,
        method: "GET",
        headers: params.headers,
        deadline: params.deadline,
        stage: "poll",
      });
    }
  }
  const error = (operation as { error?: unknown }).error;
  if (error) {
    throw new Error(JSON.stringify(error));
  }
  return operation;
}

export function buildGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input image.");
      }
      if ((req.inputVideos?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input video.");
      }
      if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
        throw new Error(
          "Google video generation does not support image and video inputs together.",
        );
      }
      const providerKey = req.provider === "google-vertex" ? "google-vertex" : "google";
      const auth = await resolveApiKeyForProvider({
        provider: providerKey,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error(
          `${providerKey === "google-vertex" ? "Google Vertex" : "Google"} API key missing`,
        );
      }
      const apiKey = auth.apiKey;
      const isVertex = providerKey === "google-vertex";

      const configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);

      const vertexConfig = isVertex
        ? { project: resolveGoogleVertexProject(), location: resolveGoogleVertexLocation() }
        : undefined;
      const restBaseUrl = resolveGoogleVideoRestBaseUrl(isVertex, configuredBaseUrl, vertexConfig);

      let authHeaders = parseGeminiAuth(apiKey).headers;
      if (isVertex) {
        authHeaders = await buildGoogleVertexHeaders({ headers: {} }, apiKey, undefined, fetch);
      }
      const durationSeconds = resolveDurationSeconds(req.durationSeconds);
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
        ...(isVertex
          ? {
              vertexai: true,
              project: resolveGoogleVertexProject(),
              location: resolveGoogleVertexLocation(),
            }
          : { apiKey }),
        httpOptions: {
          ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
          timeout: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        },
      });
      let usedRestFallback = false;
      let operation;
      try {
        operation = await client.models.generateVideos({
          model,
          prompt: req.prompt,
          ...(resolveInputImage(req) ? { image: resolveInputImage(req) } : {}),
          ...(resolveInputVideo(req) ? { video: resolveInputVideo(req) } : {}),
          config: {
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
          },
        });
      } catch (error) {
        if (hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404) {
          throw error;
        }
        usedRestFallback = true;
        operation = await generateGoogleVideoViaRest({
          baseUrl: restBaseUrl,
          headers: authHeaders,
          deadline,
          model,
          prompt: req.prompt,
          durationSeconds,
          aspectRatio,
          resolution,
          isVertex,
        });
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
          });
        }
        operation = sdkOperation;
      }
      const finalOperation = operation as { error?: unknown; name?: string };
      if (finalOperation.error) {
        throw new Error(JSON.stringify(finalOperation.error));
      }
      let generatedVideos = extractGeneratedVideos(operation);
      if (generatedVideos.length === 0 && !hasReferenceInputs && !usedRestFallback) {
        operation = await generateGoogleVideoViaRest({
          baseUrl: restBaseUrl,
          headers: authHeaders,
          deadline,
          model,
          prompt: req.prompt,
          durationSeconds,
          aspectRatio,
          resolution,
          isVertex,
        });
        generatedVideos = extractGeneratedVideos(operation);
      }
      if (generatedVideos.length === 0) {
        throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
      }
      const maxVideoBytes = resolveGeneratedVideoMaxBytes(req);
      const videos = await Promise.all(
        generatedVideos.map(async (entry, index) => {
          const inline = entry.video as
            | { videoBytes?: string; uri?: string; mimeType?: string }
            | undefined;
          if (inline?.videoBytes) {
            const buffer = Buffer.from(inline.videoBytes, "base64");
            assertGeneratedVideoBufferWithinLimit(buffer, maxVideoBytes);
            return {
              buffer,
              mimeType: normalizeOptionalString(inline.mimeType) || "video/mp4",
              fileName: `video-${index + 1}.mp4`,
            };
          }
          const directDownload = await downloadGeneratedVideoFromUri({
            uri: inline?.uri,
            apiKey,
            configuredBaseUrl,
            mimeType: inline?.mimeType,
            index,
            maxBytes: maxVideoBytes,
            timeoutMs: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          });
          if (directDownload) {
            return directDownload;
          }
          if (!inline) {
            throw new Error("Google generated video missing file handle");
          }
          const fileDownload = await downloadGeneratedVideoFromUri({
            uri: resolveGoogleGeneratedVideoFileDownloadUrl({
              file: inline,
              apiKey,
              configuredBaseUrl,
              isVertex,
              vertexConfig,
            }),
            apiKey,
            configuredBaseUrl,
            mimeType: inline.mimeType,
            index,
            maxBytes: maxVideoBytes,
            timeoutMs: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          });
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
}
