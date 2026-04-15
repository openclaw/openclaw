import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import {
  downloadKlingBinaryAsset,
  pollKlingTaskUntilComplete,
  resolveKlingHttpConfig,
  resolveKlingVideoUrl,
  submitKlingTask,
  toDataUrl,
} from "./kling-client.js";

const DEFAULT_KLING_VIDEO_MODEL = "kling-v3";
const OMNI_KLING_VIDEO_MODEL = "kling-v3-omni";
const TEXT_TO_VIDEO_ENDPOINT = "/v1/videos/text2video";
const IMAGE_TO_VIDEO_ENDPOINT = "/v1/videos/image2video";
const OMNI_VIDEO_ENDPOINT = "/v1/videos/omni-video";
const DEFAULT_VIDEO_DURATION_SECONDS = 5;
const MIN_VIDEO_DURATION_SECONDS = 3;
const MAX_VIDEO_DURATION_SECONDS = 15;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const DEFAULT_VIDEO_ASPECT_RATIO = "16:9";
const DEFAULT_VIDEO_MODE = "pro";
const DEFAULT_RETURN_URL_ONLY = false;
const RETURN_URL_ONLY_PROVIDER_OPTION = "return_url_only";
const SUPPORTED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
const SUPPORTED_DURATION_SECONDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const SUPPORTED_VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;
const SUPPORTED_VIDEO_MODELS = [DEFAULT_KLING_VIDEO_MODEL, OMNI_KLING_VIDEO_MODEL] as const;

type KlingVideoModel = (typeof SUPPORTED_VIDEO_MODELS)[number];

function resolveImageReference(input: VideoGenerationSourceAsset): string {
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("KlingAI image-to-video input is missing image data.");
  }
  return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
}

function resolveDurationSeconds(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(DEFAULT_VIDEO_DURATION_SECONDS);
  }
  const rounded = Math.round(value);
  return String(
    Math.min(MAX_VIDEO_DURATION_SECONDS, Math.max(MIN_VIDEO_DURATION_SECONDS, rounded)),
  );
}

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) {
    return "webm";
  }
  return "mp4";
}

function resolveVideoMimeTypeFromUrl(url: string): string {
  const trimmed = url.trim();
  let pathname = trimmed;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    pathname = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  }
  if (pathname.toLowerCase().endsWith(".webm")) {
    return "video/webm";
  }
  return "video/mp4";
}

function fileExtensionForVideoUrl(url: string): string {
  return fileExtensionForMimeType(resolveVideoMimeTypeFromUrl(url));
}

function resolveReturnUrlOnly(req: object): boolean {
  const optionsRaw = (req as { providerOptions?: unknown }).providerOptions;
  if (!optionsRaw || typeof optionsRaw !== "object" || Array.isArray(optionsRaw)) {
    return DEFAULT_RETURN_URL_ONLY;
  }
  const options = optionsRaw as Record<string, unknown>;
  const explicit = options[RETURN_URL_ONLY_PROVIDER_OPTION];
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return DEFAULT_RETURN_URL_ONLY;
}

function resolveVideoModel(model: string | undefined): KlingVideoModel {
  const normalized = normalizeOptionalString(model) ?? DEFAULT_KLING_VIDEO_MODEL;
  if (normalized === DEFAULT_KLING_VIDEO_MODEL || normalized === OMNI_KLING_VIDEO_MODEL) {
    return normalized;
  }
  throw new Error(
    `Unsupported KlingAI video model: ${normalized}. Supported models: ${SUPPORTED_VIDEO_MODELS.join(", ")}`,
  );
}

function resolveVideoModeFromResolution(resolution: string | undefined): "pro" | "std" {
  if (resolution === "720P") {
    return "std";
  }
  return "pro";
}

export function buildKlingaiVideoGenerationProvider(): VideoGenerationProvider {
  const capabilities = {
    providerOptions: {
      [RETURN_URL_ONLY_PROVIDER_OPTION]: "boolean",
    },
    generate: {
      maxVideos: 1,
      maxDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
      supportedDurationSecondsByModel: {
        [DEFAULT_KLING_VIDEO_MODEL]: [...SUPPORTED_DURATION_SECONDS],
        [OMNI_KLING_VIDEO_MODEL]: [...SUPPORTED_DURATION_SECONDS],
      },
      resolutions: [...SUPPORTED_VIDEO_RESOLUTIONS],
      aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
      supportsAspectRatio: true,
      supportsResolution: true,
      supportsSize: false,
      supportsAudio: true,
      supportsWatermark: true,
    },
    imageToVideo: {
      enabled: true,
      maxVideos: 1,
      maxInputImages: 1,
      maxDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
      supportedDurationSecondsByModel: {
        [DEFAULT_KLING_VIDEO_MODEL]: [...SUPPORTED_DURATION_SECONDS],
        [OMNI_KLING_VIDEO_MODEL]: [...SUPPORTED_DURATION_SECONDS],
      },
      resolutions: [...SUPPORTED_VIDEO_RESOLUTIONS],
      aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
      supportsAspectRatio: true,
      supportsResolution: true,
      supportsSize: false,
      supportsAudio: true,
      supportsWatermark: true,
    },
    videoToVideo: {
      enabled: false,
    },
  };
  return {
    id: "klingai",
    label: "KlingAI",
    defaultModel: DEFAULT_KLING_VIDEO_MODEL,
    models: [...SUPPORTED_VIDEO_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "klingai",
        agentDir,
      }),
    capabilities: capabilities as VideoGenerationProvider["capabilities"],
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("KlingAI video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("KlingAI video generation supports at most one image reference.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "klingai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("KlingAI API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveKlingHttpConfig({
        apiKey: auth.apiKey,
        configuredBaseUrl: req.cfg?.models?.providers?.klingai?.baseUrl,
        capability: "video",
      });
      const model = resolveVideoModel(req.model);
      const inputImage = req.inputImages?.[0];
      const endpointPath =
        model === OMNI_KLING_VIDEO_MODEL
          ? OMNI_VIDEO_ENDPOINT
          : inputImage
            ? IMAGE_TO_VIDEO_ENDPOINT
            : TEXT_TO_VIDEO_ENDPOINT;
      const mode = resolveVideoModeFromResolution(req.resolution);
      const resolvedAspectRatio = normalizeOptionalString(req.aspectRatio);
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "KlingAI video generation",
      });
      const isDefaultModelImageToVideo = model === DEFAULT_KLING_VIDEO_MODEL && Boolean(inputImage);
      const isOmniModelImageToVideo = model === OMNI_KLING_VIDEO_MODEL && Boolean(inputImage);
      const body: Record<string, unknown> = {
        model_name: model,
        prompt: req.prompt,
        negative_prompt: "",
        duration: resolveDurationSeconds(req.durationSeconds),
        mode: mode ?? DEFAULT_VIDEO_MODE,
        callback_url: "",
      };
      if (typeof req.audio === "boolean") {
        body.sound = req.audio ? "on" : "off";
      }
      if (isOmniModelImageToVideo) {
        if (resolvedAspectRatio) {
          body.aspect_ratio = resolvedAspectRatio;
        }
      } else if (!isDefaultModelImageToVideo) {
        body.aspect_ratio = resolvedAspectRatio ?? DEFAULT_VIDEO_ASPECT_RATIO;
      }

      if (model === OMNI_KLING_VIDEO_MODEL) {
        delete body.negative_prompt;
        if (inputImage) {
          body.image_list = [{ image_url: resolveImageReference(inputImage), type: "first_frame" }];
        }
      } else if (inputImage) {
        body.image = resolveImageReference(inputImage);
        body.external_task_id = "";
      } else {
        body.external_task_id = "";
      }
      if (typeof req.watermark === "boolean") {
        body.watermark_info = { enabled: req.watermark };
      }

      const taskId = await submitKlingTask({
        endpointPath,
        body,
        headers,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: 30_000,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        baseUrl,
        context: "KlingAI video generation",
      });
      const completed = await pollKlingTaskUntilComplete({
        queryPath: `${baseUrl}${endpointPath}`,
        taskId,
        headers,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        context: "KlingAI video generation",
      });
      const outputUrl = resolveKlingVideoUrl(completed, {
        preferWatermarkUrl: req.watermark === true,
      });
      if (!outputUrl) {
        throw new Error("KlingAI video generation completed without output URL");
      }
      const returnUrlOnly = resolveReturnUrlOnly(req);
      let video: GeneratedVideoAsset;
      if (returnUrlOnly) {
        const urlOnlyVideo = {
          url: outputUrl,
          mimeType: resolveVideoMimeTypeFromUrl(outputUrl),
          fileName: `video-1.${fileExtensionForVideoUrl(outputUrl)}`,
        };
        video = urlOnlyVideo as unknown as GeneratedVideoAsset;
      } else {
        const downloaded = await downloadKlingBinaryAsset({
          url: outputUrl,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: 30_000,
          }),
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
          context: "KlingAI generated video",
        });
        video = {
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
          fileName: `video-1.${fileExtensionForMimeType(downloaded.mimeType)}`,
        };
      }
      return {
        videos: [video],
        model,
        metadata: {
          taskId,
          taskStatus: completed.task_status,
          outputUrl,
          returnUrlOnly,
        },
      };
    },
  };
}
