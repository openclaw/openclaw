import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperationJson,
  postJsonRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationCatalogModelEntry,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_BASE_URL = "https://api.novita.ai";
const DEFAULT_MODEL = "wan2.6-t2v";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;
const WAN_SIZES = [
  "1280x720",
  "720x1280",
  "960x960",
  "1088x832",
  "832x1088",
  "1920x1080",
  "1080x1920",
  "1440x1440",
  "1632x1248",
  "1248x1632",
] as const;
const WAN_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const WAN_OPTIONS = {
  negative_prompt: "string",
  prompt_extend: "boolean",
  shot_type: "string",
  seed: "number",
} as const;
const HAILUO_OPTIONS = {
  enable_prompt_expansion: "boolean",
  fast_pretreatment: "boolean",
} as const;

const WAN_COMMON: VideoGenerationModeCapabilities = {
  maxVideos: 1,
  maxDurationSeconds: 15,
  supportedDurationSeconds: [5, 10, 15],
  resolutions: ["720P", "1080P"],
  supportsResolution: true,
  supportsAudio: true,
  supportsWatermark: true,
  maxInputAudios: 1,
  providerOptions: WAN_OPTIONS,
};
const WAN_CAPABILITIES: VideoGenerationProviderCapabilities = {
  generate: {
    ...WAN_COMMON,
    sizes: WAN_SIZES,
    aspectRatios: WAN_ASPECT_RATIOS,
    supportsSize: true,
    supportsAspectRatio: true,
  },
  imageToVideo: {
    ...WAN_COMMON,
    enabled: true,
    maxInputImages: 1,
    supportsSize: false,
    supportsAspectRatio: false,
  },
  videoToVideo: { enabled: false },
};
const HAILUO_COMMON: VideoGenerationModeCapabilities = {
  maxVideos: 1,
  maxDurationSeconds: 10,
  supportedDurationSeconds: [6, 10],
  resolutions: ["768P", "1080P"],
  supportsResolution: true,
  supportsSize: false,
  supportsAspectRatio: false,
  supportsAudio: false,
  supportsWatermark: false,
  maxInputAudios: 0,
  providerOptions: HAILUO_OPTIONS,
};
const HAILUO_CAPABILITIES: VideoGenerationProviderCapabilities = {
  generate: HAILUO_COMMON,
  imageToVideo: { ...HAILUO_COMMON, enabled: true, maxInputImages: 1 },
  videoToVideo: { enabled: false },
};
const MODEL_CATALOG: Readonly<Record<string, VideoGenerationCatalogModelEntry>> = {
  "wan2.6-t2v": { modes: ["generate", "imageToVideo"], capabilities: WAN_CAPABILITIES },
  "wan2.6-i2v": { modes: ["imageToVideo"], capabilities: WAN_CAPABILITIES },
  "minimax-hailuo-2.3-t2v": {
    modes: ["generate", "imageToVideo"],
    capabilities: HAILUO_CAPABILITIES,
  },
  "minimax-hailuo-2.3-i2v": { modes: ["imageToVideo"], capabilities: HAILUO_CAPABILITIES },
  "minimax-hailuo-2.3-fast-i2v": {
    modes: ["imageToVideo"],
    capabilities: {
      ...HAILUO_CAPABILITIES,
      imageToVideo: {
        ...HAILUO_CAPABILITIES.imageToVideo,
        enabled: true,
        providerOptions: { enable_prompt_expansion: "boolean" },
      },
    },
  },
};

function nearestDuration(
  value: number | undefined,
  allowed: readonly [number, ...number[]],
): number {
  const requested = typeof value === "number" && Number.isFinite(value) ? value : allowed[0];
  return allowed.reduce((best, current) =>
    Math.abs(current - requested) < Math.abs(best - requested) ? current : best,
  );
}

function resolveModel(req: VideoGenerationRequest): string {
  const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
  if (!Object.hasOwn(MODEL_CATALOG, model)) {
    throw new Error(`Novita video generation does not support model ${model}.`);
  }
  if ((req.inputVideos?.length ?? 0) > 0) {
    throw new Error("Novita video generation does not support video reference inputs.");
  }
  const images = req.inputImages ?? [];
  if (images.length > 1) {
    throw new Error("Novita video generation supports at most one input image.");
  }
  if (images.length === 0 && model.endsWith("-i2v")) {
    throw new Error(`Novita ${model} requires one input image.`);
  }
  if (images[0]?.role && images[0].role !== "first_frame") {
    throw new Error("Novita image-to-video supports only an ordinary or first_frame image.");
  }
  return images.length > 0 ? model.replace(/-t2v$/, "-i2v") : model;
}

function resolveImage(req: VideoGenerationRequest): string | undefined {
  const image = req.inputImages?.[0];
  if (!image) {
    return undefined;
  }
  const url = normalizeOptionalString(image.url);
  if (url) {
    return url;
  }
  if (!image.buffer) {
    throw new Error("Novita image-to-video input is missing image data.");
  }
  return toImageDataUrl({ ...image, buffer: image.buffer, defaultMimeType: "image/png" });
}

function resolveResolution(req: VideoGenerationRequest, wan: boolean): string {
  const resolution = normalizeOptionalString(req.resolution)?.toUpperCase();
  return resolution === "1080P" ? "1080P" : wan ? "720P" : "768P";
}

function resolveWanSize(req: VideoGenerationRequest): string {
  const size = normalizeOptionalString(req.size)?.replace("*", "x");
  const supported = WAN_SIZES.find((candidate) => candidate === size);
  if (supported) {
    return supported.replace("x", "*");
  }
  const aspectRatioIndex = WAN_ASPECT_RATIOS.findIndex((ratio) => ratio === req.aspectRatio);
  const index = Math.max(0, aspectRatioIndex) + (resolveResolution(req, true) === "1080P" ? 5 : 0);
  return (WAN_SIZES[index] ?? WAN_SIZES[0]).replace("x", "*");
}

function buildBody(req: VideoGenerationRequest, model: string): Record<string, unknown> {
  const wan = model.startsWith("wan");
  const image = resolveImage(req);
  const options = req.providerOptions ?? {};
  const mode = image ? "imageToVideo" : "generate";
  const schema = MODEL_CATALOG[model]?.capabilities?.[mode]?.providerOptions ?? {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== schema[key]) {
      throw new Error(`Novita ${model} does not support provider option ${key} with this value.`);
    }
  }
  const audioInputs = req.inputAudios ?? [];
  if (audioInputs.length > (wan ? 1 : 0)) {
    throw new Error(
      `Novita ${model} supports ${wan ? "at most one" : "no"} audio reference input.`,
    );
  }
  const duration = nearestDuration(req.durationSeconds, wan ? [5, 10, 15] : [6, 10]);
  const resolution = resolveResolution(req, wan);
  if (!wan) {
    if (duration === 10 && resolution === "1080P") {
      throw new Error("Novita Hailuo 1080P requires a 6-second duration; use 768P for 10 seconds.");
    }
    return { prompt: req.prompt, duration, resolution, ...options, ...(image ? { image } : {}) };
  }
  if (
    options.shot_type !== undefined &&
    options.shot_type !== "single" &&
    options.shot_type !== "multi"
  ) {
    throw new Error("Novita Wan shot_type must be single or multi.");
  }
  if (
    options.seed !== undefined &&
    (typeof options.seed !== "number" ||
      !Number.isInteger(options.seed) ||
      options.seed < 0 ||
      options.seed > 2147483647)
  ) {
    throw new Error("Novita Wan seed must be an integer between 0 and 2147483647.");
  }
  const audioUrl = normalizeOptionalString(audioInputs[0]?.url);
  if (audioInputs.length > 0 && (!audioUrl || !/^https?:\/\//i.test(audioUrl))) {
    throw new Error("Novita Wan audio reference input requires a remote http(s) URL.");
  }
  return {
    input: {
      prompt: req.prompt,
      ...(image ? { img_url: image } : {}),
      ...(audioUrl ? { audio_url: audioUrl } : {}),
      ...(options.negative_prompt !== undefined
        ? { negative_prompt: options.negative_prompt }
        : {}),
    },
    parameters: {
      ...(image ? { resolution } : { size: resolveWanSize(req) }),
      duration,
      audio: req.audio ?? false,
      prompt_extend: options.prompt_extend ?? true,
      shot_type: options.shot_type ?? "multi",
      watermark: req.watermark ?? false,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    },
  };
}

function readTask(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(payload.task)) {
    throw new Error("Novita video status response missing task.");
  }
  switch (payload.task.status) {
    case "TASK_STATUS_QUEUED":
    case "TASK_STATUS_PROCESSING":
    case "TASK_STATUS_SUCCEED":
    case "TASK_STATUS_FAILED":
      return payload.task;
    default:
      throw new Error("Novita video status response returned an unknown task status.");
  }
}

export function buildNovitaVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "novita",
    label: "NovitaAI",
    defaultModel: DEFAULT_MODEL,
    defaultTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    models: Object.keys(MODEL_CATALOG),
    catalogByModel: MODEL_CATALOG,
    capabilities: {
      generate: { maxVideos: 1 },
      imageToVideo: { enabled: true, maxVideos: 1, maxInputImages: 1 },
      videoToVideo: { enabled: false },
    },
    resolveModelCapabilities: ({ model }) => MODEL_CATALOG[model]?.capabilities,
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "novita", ...ctx }),
    async generateVideo(req) {
      const model = resolveModel(req);
      const body = buildBody(req, model);
      const auth = await resolveApiKeyForProvider({
        provider: "novita",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Novita API key missing");
      }
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        label: "Novita video generation",
      });
      const timeoutMs = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const providerConfig = req.cfg.models?.providers?.novita;
      const configuredBase = normalizeOptionalString(providerConfig?.baseUrl)
        ?.replace(/\/+$/, "")
        .replace(/\/openai\/v1$/, "");
      const { baseUrl, headers, allowPrivateNetwork, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: configuredBase ?? DEFAULT_BASE_URL,
          defaultBaseUrl: DEFAULT_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "novita",
          capability: "video",
          transport: "http",
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
        });
      const endpoint = `/v3/async/${model}`;
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${endpoint}`,
        headers,
        body,
        timeoutMs: timeoutMs(),
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      let taskId: string;
      try {
        await assertOkOrThrowHttpError(response, "Novita video generation failed", {
          bodyTimeoutMs: timeoutMs,
          requestHeaders: headers,
        });
        const submitted = await readProviderJsonObjectResponse(
          response,
          "Novita video generation failed",
          { timeoutMs },
        );
        const id = normalizeOptionalString(submitted.task_id);
        if (!id) {
          throw new Error("Novita video generation response missing task_id");
        }
        taskId = id;
      } finally {
        await release();
      }
      const pollUrl = new URL(`${baseUrl}/v3/async/task-result`);
      pollUrl.searchParams.set("task_id", taskId);
      const completed = await pollProviderOperationJson<Record<string, unknown>>({
        url: pollUrl.toString(),
        headers,
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
        maxAttempts: 120,
        pollIntervalMs: 5_000,
        requestFailedMessage: "Novita video status request failed",
        timeoutMessage: `Novita video generation task ${taskId} did not finish in time`,
        isComplete: (payload) => readTask(payload).status === "TASK_STATUS_SUCCEED",
        getFailureMessage: (payload) => {
          const task = readTask(payload);
          return task.status === "TASK_STATUS_FAILED"
            ? `Novita video generation failed: ${normalizeOptionalString(task.reason) ?? "task failed"}`
            : undefined;
        },
      });
      const output = Array.isArray(completed.videos) ? completed.videos[0] : undefined;
      const videoUrl = isRecord(output) ? normalizeOptionalString(output.video_url) : undefined;
      if (!videoUrl) {
        throw new Error("Novita video generation completed without a video URL");
      }
      const video = await downloadGeneratedVideoAsset({
        url: videoUrl,
        timeoutMs,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        provider: "novita",
        label: "Novita generated video download",
        requestFailedMessage: "Novita generated video download failed",
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
        validateBinaryResponse: true,
        metadata: { sourceUrl: videoUrl },
      });
      return { videos: [video], model, metadata: { taskId, endpoint, videoUrl } };
    },
  };
}
