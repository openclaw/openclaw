import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  VIDU_BASE_URL,
  VIDU_DEFAULT_MODEL,
  VIDU_IMG2VIDEO_MODELS,
  VIDU_REFERENCE2VIDEO_MODELS,
  VIDU_STARTEND2VIDEO_MODELS,
  VIDU_TEXT2VIDEO_MODELS,
  VIDU_VIDEO_REFERENCE_MODELS,
} from "./models.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;

type ViduTaskCreateResponse = {
  task_id?: string;
  state?: string;
  code?: number;
  message?: string;
};

type ViduCreation = {
  id?: string;
  url?: string;
  cover_url?: string;
  watermarked_url?: string;
};

type ViduTaskResponse = {
  id?: string;
  state?: "created" | "queueing" | "processing" | "success" | "failed";
  err_code?: string;
  message?: string;
  creations?: ViduCreation[];
};

function resolveViduVideoBaseUrl(req: VideoGenerationRequest): string {
  return normalizeOptionalString(req.cfg?.models?.providers?.vidu?.baseUrl) ?? VIDU_BASE_URL;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveViduImageUrls(req: VideoGenerationRequest): string[] {
  const images = req.inputImages;
  if (!images || images.length === 0) {
    return [];
  }
  return images.map((input, index) => {
    const inputUrl = normalizeOptionalString(input.url);
    if (inputUrl) {
      return inputUrl;
    }
    if (!input.buffer) {
      throw new Error(`Vidu image input at index ${index} is missing image data.`);
    }
    return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
  });
}

function resolveViduImageRoles(req: VideoGenerationRequest): (string | undefined)[] {
  const images = req.inputImages;
  if (!images || images.length === 0) {
    return [];
  }
  return images.map((input) => {
    const metadata = input.metadata;
    const role = normalizeOptionalString(metadata?.role as string | undefined);
    // Validate role values
    if (role && !["start-frame", "end-frame", "reference"].includes(role)) {
      throw new Error(
        `Invalid image role "${role}". Supported roles: "start-frame", "end-frame", "reference"`,
      );
    }
    return role;
  });
}

async function pollViduTask(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<ViduTaskResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/ent/v2/tasks/${params.taskId}/creations`,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Vidu video status request failed");
    const payload = (await response.json()) as ViduTaskResponse;
    switch (normalizeOptionalString(payload.state)) {
      case "success":
        return payload;
      case "failed": {
        const code = normalizeOptionalString(payload.err_code);
        const msg = normalizeOptionalString(payload.message);
        const detail = [code, msg].filter(Boolean).join(": ");
        throw new Error(detail || "Vidu video generation failed");
      }
      case "created":
      case "queueing":
      case "processing":
      default:
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        break;
    }
  }
  throw new Error(`Vidu video generation task ${params.taskId} did not finish in time`);
}

async function downloadViduVideo(params: {
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
  await assertOkOrThrowHttpError(response, "Vidu generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

function resolveViduVideoUrls(req: VideoGenerationRequest): string[] {
  const videos = req.inputVideos;
  if (!videos || videos.length === 0) {
    return [];
  }
  return videos.map((input, index) => {
    const inputUrl = normalizeOptionalString(input.url);
    if (inputUrl) {
      return inputUrl;
    }
    if (!input.buffer) {
      throw new Error(`Vidu video input at index ${index} is missing video data.`);
    }
    return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "video/mp4");
  });
}

function resolveViduEndpoint(
  imageUrls: string[],
  videoUrls: string[],
  imageRoles?: (string | undefined)[],
): string {
  // Video references always use reference2video
  if (videoUrls.length > 0) {
    return "/ent/v2/reference2video";
  }
  if (imageUrls.length === 0) {
    return "/ent/v2/text2video";
  }
  if (imageUrls.length === 1) {
    // A single image with role "reference" should use reference2video
    const hasReferenceRole = imageRoles?.some((role) => role === "reference");
    if (hasReferenceRole) {
      return "/ent/v2/reference2video";
    }
    return "/ent/v2/img2video";
  }
  if (imageUrls.length === 2) {
    // Check if explicitly marked as reference
    const hasReferenceRole = imageRoles?.some((role) => role === "reference");
    if (hasReferenceRole) {
      return "/ent/v2/reference2video";
    }
    // Check if marked as start-end frames
    const hasStartEndRoles = imageRoles?.some(
      (role) => role === "start-frame" || role === "end-frame",
    );
    if (hasStartEndRoles) {
      return "/ent/v2/start-end2video";
    }
    // Default to start-end2video for 2 images
    return "/ent/v2/start-end2video";
  }
  // 3+ images → reference2video
  return "/ent/v2/reference2video";
}

function validateModelForEndpoint(model: string, endpoint: string): void {
  const supportedMap: Record<string, Set<string>> = {
    "/ent/v2/text2video": VIDU_TEXT2VIDEO_MODELS,
    "/ent/v2/img2video": VIDU_IMG2VIDEO_MODELS,
    "/ent/v2/reference2video": VIDU_REFERENCE2VIDEO_MODELS,
    "/ent/v2/start-end2video": VIDU_STARTEND2VIDEO_MODELS,
  };
  const supported = supportedMap[endpoint];
  if (supported && !supported.has(model)) {
    const mode = endpoint.split("/").pop();
    const available = [...supported].join(", ");
    throw new Error(
      `Vidu model "${model}" does not support ${mode}. Supported models: ${available}`,
    );
  }
}

export function buildViduVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "vidu",
    label: "Vidu",
    defaultModel: VIDU_DEFAULT_MODEL,
    models: [
      "viduq3-pro",
      "viduq3-turbo",
      "viduq2-pro",
      "viduq2-pro-fast",
      "viduq2-turbo",
      "viduq2",
      "viduq1",
      "viduq1-classic",
      "vidu2.0",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "vidu",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 16,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 7,
        maxDurationSeconds: 16,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 2,
        maxDurationSeconds: 10,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "vidu",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Vidu API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveViduVideoBaseUrl(req),
          defaultBaseUrl: VIDU_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Token ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "vidu",
          capability: "video",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? VIDU_DEFAULT_MODEL;
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };

      const imageUrls = resolveViduImageUrls(req);
      const imageRoles = resolveViduImageRoles(req);
      const videoUrls = resolveViduVideoUrls(req);
      const endpoint = resolveViduEndpoint(imageUrls, videoUrls, imageRoles);
      validateModelForEndpoint(model, endpoint);

      if (videoUrls.length > 0 && !VIDU_VIDEO_REFERENCE_MODELS.has(model)) {
        const available = [...VIDU_VIDEO_REFERENCE_MODELS].join(", ");
        throw new Error(
          `Vidu model "${model}" does not support video reference inputs. Supported models: ${available}`,
        );
      }

      if (endpoint === "/ent/v2/reference2video") {
        if (videoUrls.length > 0) {
          // Non-subject mode with images + videos
          if (imageUrls.length > 0) {
            body.images = imageUrls;
          }
          body.videos = videoUrls;
        } else {
          // Subject mode: each image is a separate subject
          body.subjects = imageUrls.map((url, i) => ({
            name: String(i + 1),
            images: [url],
          }));
        }
      } else if (endpoint === "/ent/v2/start-end2video") {
        // Start-end mode: respect role metadata for ordering
        if (imageUrls.length !== 2) {
          throw new Error("Start-end2video requires exactly 2 images");
        }
        const startIdx = imageRoles?.indexOf("start-frame") ?? -1;
        const endIdx = imageRoles?.indexOf("end-frame") ?? -1;
        if (startIdx !== -1 && endIdx !== -1) {
          body.images = [imageUrls[startIdx], imageUrls[endIdx]];
        } else {
          body.images = imageUrls;
        }
      } else if (imageUrls.length > 0) {
        // Image-to-video
        body.images = imageUrls;
      }

      if (req.aspectRatio) {
        body.aspect_ratio = req.aspectRatio;
      }
      if (req.resolution) {
        body.resolution = req.resolution.toLowerCase();
      }
      if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
        body.duration = Math.max(1, Math.round(req.durationSeconds));
      }
      if (typeof req.audio === "boolean") {
        body.audio = req.audio;
      }
      if (typeof req.watermark === "boolean") {
        body.watermark = req.watermark;
      }

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${endpoint}`,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "Vidu video generation failed");
        const submitted = (await response.json()) as ViduTaskCreateResponse;
        const taskId = normalizeOptionalString(submitted.task_id);
        if (!taskId) {
          throw new Error("Vidu video generation response missing task_id");
        }
        const completed = await pollViduTask({
          taskId,
          headers,
          timeoutMs: req.timeoutMs,
          baseUrl,
          fetchFn,
        });
        const videoUrl = normalizeOptionalString(completed.creations?.[0]?.url);
        if (!videoUrl) {
          throw new Error("Vidu video generation completed without a video URL");
        }
        const video = await downloadViduVideo({
          url: videoUrl,
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          videos: [video],
          model,
          metadata: {
            taskId,
            state: completed.state,
            videoUrl,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
