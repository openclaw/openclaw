import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { BYTEPLUS_BASE_URL } from "./models.js";

const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-1-0-lite-t2v-250428";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;

type BytePlusTaskCreateResponse = {
  id?: string;
};

type BytePlusTaskResponse = {
  id?: string;
  model?: string;
  status?: "running" | "failed" | "queued" | "succeeded" | "cancelled";
  error?: {
    code?: string;
    message?: string;
  };
  content?: {
    video_url?: string;
    last_frame_url?: string;
    file_url?: string;
  };
  duration?: number;
  ratio?: string;
  resolution?: string;
};

function resolveBytePlusVideoBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.byteplus?.baseUrl?.trim() || BYTEPLUS_BASE_URL;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveBytePlusImageUrl(req: VideoGenerationRequest): string | undefined {
  const input = req.inputImages?.[0];
  if (!input) {
    return undefined;
  }
  if (input.url?.trim()) {
    return input.url.trim();
  }
  if (!input.buffer) {
    throw new Error("BytePlus reference image is missing image data.");
  }
  return toDataUrl(input.buffer, input.mimeType?.trim() || "image/png");
}

async function pollBytePlusTask(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<BytePlusTaskResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/contents/generations/tasks/${params.taskId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "BytePlus video status request failed");
    const payload = (await response.json()) as BytePlusTaskResponse;
    switch (payload.status?.trim()) {
      case "succeeded":
        return payload;
      case "failed":
      case "cancelled":
        throw new Error(payload.error?.message?.trim() || "BytePlus video generation failed");
      case "queued":
      case "running":
      default:
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        break;
    }
  }
  throw new Error(`BytePlus video generation task ${params.taskId} did not finish in time`);
}

async function downloadBytePlusVideo(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "BytePlus generated video download failed");
  const mimeType = response.headers.get("content-type")?.trim() || "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

export function buildBytePlusVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "byteplus",
    label: "BytePlus",
    defaultModel: DEFAULT_BYTEPLUS_VIDEO_MODEL,
    models: [
      DEFAULT_BYTEPLUS_VIDEO_MODEL,
      "seedance-1-0-lite-i2v-250428",
      "seedance-1-0-pro-250528",
      "seedance-1-5-pro-251215",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "byteplus",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 12,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 12,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("BytePlus video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "byteplus",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("BytePlus API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveBytePlusVideoBaseUrl(req),
          defaultBaseUrl: BYTEPLUS_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "byteplus",
          capability: "video",
          transport: "http",
        });
      const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
      const imageUrl = resolveBytePlusImageUrl(req);
      if (imageUrl) {
        content.push({
          type: "image_url",
          image_url: { url: imageUrl },
          role: "first_frame",
        });
      }
      const body: Record<string, unknown> = {
        model: req.model?.trim() || DEFAULT_BYTEPLUS_VIDEO_MODEL,
        content,
      };
      if (req.aspectRatio?.trim()) {
        body.ratio = req.aspectRatio.trim();
      }
      if (req.resolution) {
        body.resolution = req.resolution;
      }
      if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
        body.duration = Math.max(1, Math.round(req.durationSeconds));
      }
      if (typeof req.audio === "boolean") {
        body.generate_audio = req.audio;
      }
      if (typeof req.watermark === "boolean") {
        body.watermark = req.watermark;
      }

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/contents/generations/tasks`,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "BytePlus video generation failed");
        const submitted = (await response.json()) as BytePlusTaskCreateResponse;
        const taskId = submitted.id?.trim();
        if (!taskId) {
          throw new Error("BytePlus video generation response missing task id");
        }
        const completed = await pollBytePlusTask({
          taskId,
          headers,
          timeoutMs: req.timeoutMs,
          baseUrl,
          fetchFn,
        });
        const videoUrl = completed.content?.video_url?.trim();
        if (!videoUrl) {
          throw new Error("BytePlus video generation completed without a video URL");
        }
        const video = await downloadBytePlusVideo({
          url: videoUrl,
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          videos: [video],
          model: completed.model ?? req.model ?? DEFAULT_BYTEPLUS_VIDEO_MODEL,
          metadata: {
            taskId,
            status: completed.status,
            videoUrl,
            ratio: completed.ratio,
            resolution: completed.resolution,
            duration: completed.duration,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
