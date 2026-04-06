import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResolution,
} from "openclaw/plugin-sdk/video-generation";
import { VENICE_BASE_URL } from "./models.js";

const DEFAULT_VENICE_VIDEO_MODEL = "wan-2.7-image-to-video";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180;

type VeniceQueueVideoResponse = {
  model?: string;
  queue_id?: string;
  error?: string;
};

type VeniceRetrieveVideoResponse = {
  status?: "PROCESSING" | "QUEUED" | "PENDING";
  average_execution_time?: number;
  execution_duration?: number;
  error?: string;
};

function resolveVeniceVideoBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.venice?.baseUrl?.trim() || VENICE_BASE_URL;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function normalizeResolution(resolution?: VideoGenerationResolution): string | undefined {
  if (!resolution) return undefined;
  // Venice uses lowercase: 480p, 720p, 1080p
  return resolution.toLowerCase();
}

function normalizeDuration(durationSeconds?: number): string | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  // Venice supports 5s and 10s
  if (durationSeconds <= 5) return "5s";
  return "10s";
}

function isImageToVideoModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("image-to-video") || normalized.includes("i2v");
}

async function pollVeniceVideo(params: {
  queueId: string;
  model: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<Buffer> {
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + effectiveTimeout;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    // Check if we've exceeded the total timeout
    if (Date.now() >= deadline) {
      break;
    }

    const body = {
      model: params.model,
      queue_id: params.queueId,
      delete_media_on_completion: true,
    };
    const { response, release } = await postJsonRequest({
      url: `${params.baseUrl}/video/retrieve`,
      headers: params.headers,
      body,
      timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, deadline - Date.now()),
      fetchFn: params.fetchFn,
      allowPrivateNetwork: false,
    });
    try {
      // Venice returns video/mp4 when complete, application/json when processing
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("video/") || contentType.includes("application/octet-stream")) {
        // Video is ready - download it
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      if (!response.ok) {
        const errorBody = (await response.json()) as VeniceRetrieveVideoResponse;
        if (errorBody.error) {
          throw new Error(errorBody.error);
        }
        throw new Error(`Venice video retrieve failed: HTTP ${response.status}`);
      }

      // Parse status
      const statusBody = (await response.json()) as VeniceRetrieveVideoResponse;

      if (statusBody.error) {
        throw new Error(statusBody.error);
      }

      // Handle known processing states - wait before retrying
      if (
        statusBody.status === "PROCESSING" ||
        statusBody.status === "QUEUED" ||
        statusBody.status === "PENDING"
      ) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      // Unknown status - still wait before retrying to avoid tight loops
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } finally {
      await release();
    }
  }
  throw new Error(`Venice video generation task ${params.queueId} did not finish in time`);
}

export function buildVeniceVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "venice",
    aliases: ["veniceai"],
    label: "Venice",
    defaultModel: DEFAULT_VENICE_VIDEO_MODEL,
    models: [
      // WAN models (Image-to-Video and Text-to-Video)
      "wan-2.7-image-to-video",
      "wan-2.7-text-to-video",
      "wan-2.6-image-to-video",
      "wan-2.5-preview-image-to-video",

      // Kling 2.6 models
      "kling-2.6-pro-image-to-video",
      "kling-2.6-pro-text-to-video",

      // Kling 2.5 Turbo models
      "kling-2.5-turbo-pro-image-to-video",
      "kling-2.5-turbo-pro-text-to-video",

      // Seedance 2.0 models (Pro users)
      "seedance-2-0-image-to-video",
      "seedance-2-0-text-to-video",

      // Seedance 1.5 Pro models
      "seedance-1-5-pro-image-to-video",
      "seedance-1-5-pro-text-to-video",

      // Vidu Q3 models
      "vidu-q3-image-to-video",
      "vidu-q3-text-to-video",

      // OVI (MiniMax) model
      "ovi-image-to-video",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "venice",
        agentDir,
      }),
    capabilities: {
      maxVideos: 1,
      maxInputImages: 1,
      maxInputVideos: 1,
      maxDurationSeconds: 10,
      supportedDurationSeconds: [5, 10],
      supportsResolution: true,
      supportsAspectRatio: true,
      supportsAudio: true,
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "venice",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Venice API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, headers } = resolveProviderHttpRequestConfig({
        baseUrl: resolveVeniceVideoBaseUrl(req),
        defaultBaseUrl: VENICE_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        provider: "venice",
        capability: "video",
        transport: "http",
      });

      // Determine model - use image-to-video if image provided, otherwise text-to-video
      const hasInputImage = (req.inputImages?.length ?? 0) > 0;
      const hasInputVideo = (req.inputVideos?.length ?? 0) > 0;
      let model = req.model?.trim() || DEFAULT_VENICE_VIDEO_MODEL;

      // Validate: if an I2V model is explicitly chosen but no image is provided, error early
      if (!req.model && !hasInputImage && !hasInputVideo) {
        // Auto-select text-to-video model if no image/video provided
        model = "wan-2.7-text-to-video";
      } else if (req.model && isImageToVideoModel(req.model) && !hasInputImage) {
        throw new Error(
          `Model "${req.model}" requires a reference image. Either provide an image via inputImages or use a text-to-video model.`,
        );
      }

      // Build request body per Venice API spec
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
        duration: normalizeDuration(req.durationSeconds) || "5s",
      };

      // Add resolution if provided
      if (req.resolution) {
        body.resolution = normalizeResolution(req.resolution);
      }

      // Add aspect ratio if provided
      if (req.aspectRatio) {
        body.aspect_ratio = req.aspectRatio;
      }

      // Add audio toggle if specified
      if (typeof req.audio === "boolean") {
        body.audio = req.audio;
      }

      // Add reference image for image-to-video models
      if (hasInputImage && req.inputImages?.[0]) {
        const input = req.inputImages[0];
        const imageUrl = input.url?.trim()
          ? input.url.trim()
          : input.buffer
            ? toDataUrl(input.buffer, input.mimeType?.trim() || "image/png")
            : undefined;
        if (!imageUrl) {
          throw new Error("Venice reference image is missing image data.");
        }
        body.image_url = imageUrl;
      }

      // Add reference video for video-to-video/upscale models
      if (hasInputVideo && req.inputVideos?.[0]) {
        const input = req.inputVideos[0];
        const videoUrl = input.url?.trim()
          ? input.url.trim()
          : input.buffer
            ? toDataUrl(input.buffer, input.mimeType?.trim() || "video/mp4")
            : undefined;
        if (!videoUrl) {
          throw new Error("Venice reference video is missing video data.");
        }
        body.video_url = videoUrl;
      }

      // Queue the video generation
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/video/queue`,
        headers,
        body,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn,
        allowPrivateNetwork: false,
      });

      let queueId: string;
      let returnedModel: string;

      try {
        await assertOkOrThrowHttpError(response, "Venice video queue failed");
        const queueResponse = (await response.json()) as VeniceQueueVideoResponse;

        if (queueResponse.error) {
          throw new Error(queueResponse.error);
        }

        queueId = queueResponse.queue_id?.trim() || "";
        returnedModel = queueResponse.model?.trim() || model;

        if (!queueId) {
          throw new Error("Venice video queue response missing queue_id");
        }
      } finally {
        await release();
      }

      // Poll for completion
      const videoBuffer = await pollVeniceVideo({
        queueId,
        model: returnedModel,
        headers,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        baseUrl,
        fetchFn,
      });

      const video: GeneratedVideoAsset = {
        buffer: videoBuffer,
        mimeType: "video/mp4",
        fileName: `video-1.mp4`,
      };

      return {
        videos: [video],
        model: returnedModel,
        metadata: {
          queueId,
          provider: "venice",
        },
      };
    },
  };
}
