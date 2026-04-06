import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { normalizeGoogleApiBaseUrl } from "./api.js";

const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 90;
const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS = [4, 6, 8] as const;
const GOOGLE_VIDEO_MIN_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[0];
const GOOGLE_VIDEO_MAX_DURATION_SECONDS =
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.length - 1];
const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE =
  "Google video generation response missing generated videos";

type GoogleVideoOperationRecord = Record<string, unknown> & {
  done?: boolean;
  error?: unknown;
  name?: string;
};

class GoogleVideoEmptyResultError extends Error {
  constructor() {
    super(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
    this.name = "GoogleVideoEmptyResultError";
  }
}

function resolveConfiguredGoogleVideoBaseUrl(req: VideoGenerationRequest): string | undefined {
  const configured = req.cfg?.models?.providers?.google?.baseUrl?.trim();
  return configured ? normalizeGoogleApiBaseUrl(configured) : undefined;
}

function resolveGoogleVideoBaseUrl(req: VideoGenerationRequest): string {
  return resolveConfiguredGoogleVideoBaseUrl(req) ?? DEFAULT_GOOGLE_VIDEO_BASE_URL;
}

function resolveAspectRatio(params: {
  aspectRatio?: string;
  size?: string;
}): "16:9" | "9:16" | undefined {
  const direct = params.aspectRatio?.trim();
  if (direct === "16:9" || direct === "9:16") {
    return direct;
  }
  const size = params.size?.trim();
  if (!size) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return width >= height ? "16:9" : "9:16";
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
  const size = params.size?.trim();
  if (!size) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  const maxEdge = Math.max(width, height);
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

function buildGoogleVideoConfig(params: {
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  generateAudio?: boolean;
  includeNumberOfVideos?: boolean;
}) {
  return {
    ...(params.includeNumberOfVideos === true ? { numberOfVideos: 1 } : {}),
    ...(typeof params.durationSeconds === "number"
      ? { durationSeconds: params.durationSeconds }
      : {}),
    ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
    ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.generateAudio === true ? { generateAudio: true } : {}),
  };
}

function resolveInputImage(req: VideoGenerationRequest) {
  const input = req.inputImages?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    imageBytes: input.buffer.toString("base64"),
    mimeType: input.mimeType?.trim() || "image/png",
  };
}

function resolveInputVideo(req: VideoGenerationRequest) {
  const input = req.inputVideos?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    videoBytes: input.buffer.toString("base64"),
    mimeType: input.mimeType?.trim() || "video/mp4",
  };
}

async function requestGoogleVideoJson(params: {
  url: string;
  method: "GET" | "POST";
  apiKey: string;
  body?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(params.url, {
      method: params.method,
      headers: {
        "x-goog-api-key": params.apiKey,
        ...(params.body ? { "content-type": "application/json" } : {}),
      },
      ...(params.body ? { body: params.body } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(typeof payload === "object" ? JSON.stringify(payload) : String(payload));
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseGoogleApiErrorCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const directCode = record.code;
  if (typeof directCode === "number") {
    return directCode;
  }
  const nestedError = record.error;
  if (!nestedError || typeof nestedError !== "object") {
    return undefined;
  }
  const nestedCode = (nestedError as Record<string, unknown>).code;
  return typeof nestedCode === "number" ? nestedCode : undefined;
}

function extractGoogleApiErrorCode(error: unknown): number | undefined {
  if (error instanceof Error) {
    try {
      return parseGoogleApiErrorCode(JSON.parse(error.message));
    } catch {
      return undefined;
    }
  }
  return parseGoogleApiErrorCode(error);
}

function extractGeneratedVideos(operation: unknown): Array<{ video: unknown }> {
  const op = operation as Record<string, unknown>;
  const response = op.response as Record<string, unknown> | undefined;
  const generatedVideos = response?.generatedVideos;
  if (Array.isArray(generatedVideos) && generatedVideos.length > 0) {
    return generatedVideos as Array<{ video: unknown }>;
  }
  const generateVideoResponse = response?.generateVideoResponse as
    | Record<string, unknown>
    | undefined;
  const generatedSamples = generateVideoResponse?.generatedSamples;
  if (!Array.isArray(generatedSamples) || generatedSamples.length === 0) {
    return [];
  }
  return (generatedSamples as Array<Record<string, unknown>>).map((sample) => ({
    video: sample.video,
  }));
}

async function downloadGoogleVideoUri(params: {
  uri: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(params.uri, {
      method: "GET",
      headers: { "x-goog-api-key": params.apiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Google video download failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function shouldFallbackToGoogleRest(error: unknown): boolean {
  if (error instanceof GoogleVideoEmptyResultError) {
    return true;
  }
  return extractGoogleApiErrorCode(error) === 404;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollGoogleSdkVideoOperation(params: {
  client: GoogleGenAI;
  operation: unknown;
}): Promise<unknown> {
  let operation = params.operation;
  for (let attempt = 0; !((operation as GoogleVideoOperationRecord).done ?? false); attempt += 1) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new Error("Google video generation did not finish in time");
    }
    await sleep(POLL_INTERVAL_MS);
    operation = await params.client.operations.getVideosOperation({
      operation: operation as never,
    });
  }
  const finalOperation = operation as GoogleVideoOperationRecord;
  if (finalOperation.error) {
    throw new Error(JSON.stringify(finalOperation.error));
  }
  return operation;
}

async function generateGoogleVideoViaSdk(params: {
  client: GoogleGenAI;
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  generateAudio?: boolean;
  image?: { imageBytes: string; mimeType: string };
  video?: { videoBytes: string; mimeType: string };
}): Promise<unknown> {
  const operation = await params.client.models.generateVideos({
    model: params.model,
    prompt: params.prompt,
    image: params.image,
    video: params.video,
    config: buildGoogleVideoConfig({
      includeNumberOfVideos: true,
      durationSeconds: params.durationSeconds,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      generateAudio: params.generateAudio,
    }),
  });
  return await pollGoogleSdkVideoOperation({
    client: params.client,
    operation,
  });
}

async function generateGoogleVideoViaRest(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  generateAudio?: boolean;
}): Promise<unknown> {
  const submitBody = {
    instances: [{ prompt: params.prompt }],
    parameters: buildGoogleVideoConfig({
      durationSeconds: params.durationSeconds,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      generateAudio: params.generateAudio,
    }),
  };

  let operation = await requestGoogleVideoJson({
    url: `${params.baseUrl}/models/${encodeURIComponent(params.model)}:predictLongRunning`,
    method: "POST",
    apiKey: params.apiKey,
    body: JSON.stringify(submitBody),
    timeoutMs: params.timeoutMs,
  });

  for (let attempt = 0; !((operation as Record<string, unknown>).done ?? false); attempt += 1) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new Error("Google video generation did not finish in time");
    }
    await sleep(POLL_INTERVAL_MS);
    const opName = (operation as Record<string, unknown>).name;
    if (typeof opName !== "string" || !opName) {
      throw new Error("Google video operation response missing name for polling");
    }
    operation = await requestGoogleVideoJson({
      url: `${params.baseUrl}/${opName}`,
      method: "GET",
      apiKey: params.apiKey,
      timeoutMs: params.timeoutMs,
    });
  }

  const op = operation as Record<string, unknown>;
  if (op.error) {
    throw new Error(JSON.stringify(op.error));
  }
  return operation;
}

async function toGoogleVideoResult(params: {
  operation: unknown;
  apiKey: string;
  timeoutMs?: number;
  model: string;
  client?: GoogleGenAI;
}): Promise<{
  videos: GeneratedVideoAsset[];
  model: string;
  metadata?: { operationName: string };
}> {
  const generatedVideos = extractGeneratedVideos(params.operation);
  if (generatedVideos.length === 0) {
    throw new GoogleVideoEmptyResultError();
  }
  const op = params.operation as Record<string, unknown>;
  return {
    videos: await Promise.all(
      generatedVideos.map(async (entry, index) => {
        const inline = entry.video as
          | { videoBytes?: string; uri?: string; mimeType?: string }
          | undefined;
        if (inline?.videoBytes) {
          return {
            buffer: Buffer.from(inline.videoBytes, "base64"),
            mimeType: inline.mimeType?.trim() || "video/mp4",
            fileName: `video-${index + 1}.mp4`,
          };
        }
        if (typeof inline?.uri === "string" && inline.uri.length > 0) {
          try {
            return {
              buffer: await downloadGoogleVideoUri({
                uri: inline.uri,
                apiKey: params.apiKey,
                timeoutMs: params.timeoutMs,
              }),
              mimeType: inline.mimeType?.trim() || "video/mp4",
              fileName: `video-${index + 1}.mp4`,
            };
          } catch (err) {
            if (!params.client) {
              throw err;
            }
            return await downloadGeneratedVideo({
              client: params.client,
              file: inline,
              index,
            });
          }
        }
        if (!inline) {
          throw new Error("Google generated video missing file handle");
        }
        if (!params.client) {
          throw new Error("Google generated video missing downloadable uri");
        }
        return await downloadGeneratedVideo({
          client: params.client,
          file: inline,
          index,
        });
      }),
    ),
    model: params.model,
    metadata: typeof op.name === "string" ? { operationName: op.name } : undefined,
  };
}

async function downloadGeneratedVideo(params: {
  client: GoogleGenAI;
  file: unknown;
  index: number;
}): Promise<GeneratedVideoAsset> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-video-"));
  const downloadPath = path.join(tempDir, `video-${params.index + 1}.mp4`);
  try {
    await params.client.files.download({
      file: params.file as never,
      downloadPath,
    });
    const buffer = await readFile(downloadPath);
    return {
      buffer,
      mimeType: "video/mp4",
      fileName: `video-${params.index + 1}.mp4`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    models: [
      DEFAULT_GOOGLE_VIDEO_MODEL,
      "veo-3.1-generate-preview",
      "veo-3.1-lite-generate-preview",
      "veo-3.0-fast-generate-001",
      "veo-3.0-generate-001",
      "veo-2.0-generate-001",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "google",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
    },
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
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
      const baseUrl = resolveGoogleVideoBaseUrl(req);
      const durationSeconds = resolveDurationSeconds(req.durationSeconds);
      const model = req.model?.trim() || DEFAULT_GOOGLE_VIDEO_MODEL;
      const aspectRatio = resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size });
      const resolution = resolveResolution({ resolution: req.resolution, size: req.size });
      const inputImage = resolveInputImage(req);
      const inputVideo = resolveInputVideo(req);
      const client = new GoogleGenAI({
        apiKey: auth.apiKey,
        httpOptions: {
          ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
          timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      });

      const hasReferenceInputs =
        (req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0;

      if (!hasReferenceInputs) {
        try {
          const operation = await generateGoogleVideoViaSdk({
            client,
            model,
            prompt: req.prompt,
            durationSeconds,
            aspectRatio,
            resolution,
            generateAudio: req.audio === true,
          });
          return await toGoogleVideoResult({
            operation,
            apiKey: auth.apiKey,
            timeoutMs: req.timeoutMs,
            model,
            client,
          });
        } catch (error) {
          if (!shouldFallbackToGoogleRest(error)) {
            throw error;
          }
          const operation = await generateGoogleVideoViaRest({
            baseUrl,
            apiKey: auth.apiKey,
            timeoutMs: req.timeoutMs,
            model,
            prompt: req.prompt,
            durationSeconds,
            aspectRatio,
            resolution,
            generateAudio: req.audio === true,
          });
          return await toGoogleVideoResult({
            operation,
            apiKey: auth.apiKey,
            timeoutMs: req.timeoutMs,
            model,
          });
        }
      }

      const operation = await generateGoogleVideoViaSdk({
        client,
        model,
        prompt: req.prompt,
        durationSeconds,
        aspectRatio,
        resolution,
        generateAudio: req.audio === true,
        image: inputImage,
        video: inputVideo,
      });
      return await toGoogleVideoResult({
        operation,
        apiKey: auth.apiKey,
        timeoutMs: req.timeoutMs,
        model,
        client,
      });
    },
  };
}
