import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperationJson,
  postJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";

type ModelInput = {
  durations?: readonly number[];
  numericDuration?: boolean;
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  uppercaseResolution?: boolean;
  audioField?: "sound" | "generate_audio";
  imageField?: "image_urls" | "image_url" | "input_urls";
  maxPromptLength: number;
  minPromptLength?: number;
};

type ModelFamily = {
  textModel?: string;
  imageModel: string;
  text?: ModelInput;
  image: ModelInput;
};

const KLING: ModelInput = {
  durations: [5, 10],
  audioField: "sound",
  maxPromptLength: 1000,
};
const GROK: ModelInput = {
  durations: Array.from({ length: 25 }, (_, index) => index + 6),
  resolutions: ["480P", "720P", "1080P"],
  maxPromptLength: 5000,
};
const WAN: ModelInput = {
  durations: [5, 10, 15],
  resolutions: ["1080P", "720P"],
  maxPromptLength: 5000,
};
const HAILUO: ModelInput = { maxPromptLength: 1500 };
const HAILUO_23: ModelInput = {
  durations: [6, 10],
  resolutions: ["768P", "1080P"],
  uppercaseResolution: true,
  imageField: "image_url",
  maxPromptLength: 5000,
};
const SEEDANCE: ModelInput = {
  durations: Array.from({ length: 9 }, (_, index) => index + 4),
  numericDuration: true,
  resolutions: ["720P", "480P", "1080P"],
  aspectRatios: ["16:9", "1:1", "4:3", "3:4", "9:16", "21:9"],
  audioField: "generate_audio",
  maxPromptLength: 20000,
  minPromptLength: 3,
};

// Each family owns both routing and the input contract used for capability discovery.
const KIE_VIDEO_FAMILIES: readonly ModelFamily[] = [
  {
    textModel: "kling-2.6/text-to-video",
    imageModel: "kling-2.6/image-to-video",
    text: { ...KLING, aspectRatios: ["16:9", "1:1", "9:16"] },
    image: { ...KLING, imageField: "image_urls" },
  },
  {
    textModel: "grok-imagine/text-to-video",
    imageModel: "grok-imagine/image-to-video",
    text: {
      ...GROK,
      numericDuration: true,
      aspectRatios: ["16:9", "2:3", "3:2", "1:1", "9:16"],
    },
    image: { ...GROK, imageField: "image_urls" },
  },
  {
    textModel: "wan/2-6-text-to-video",
    imageModel: "wan/2-6-image-to-video",
    text: WAN,
    image: { ...WAN, imageField: "image_urls", minPromptLength: 2 },
  },
  {
    textModel: "hailuo/02-text-to-video-standard",
    imageModel: "hailuo/02-image-to-video-standard",
    text: { ...HAILUO, durations: [6, 10] },
    image: {
      ...HAILUO,
      durations: [6, 10],
      resolutions: ["768P", "512P"],
      uppercaseResolution: true,
      imageField: "image_url",
    },
  },
  {
    textModel: "hailuo/02-text-to-video-pro",
    imageModel: "hailuo/02-image-to-video-pro",
    text: HAILUO,
    image: { ...HAILUO, imageField: "image_url" },
  },
  { imageModel: "hailuo/2-3-image-to-video-standard", image: HAILUO_23 },
  { imageModel: "hailuo/2-3-image-to-video-pro", image: HAILUO_23 },
  {
    textModel: "bytedance/seedance-1.5-pro",
    imageModel: "bytedance/seedance-1.5-pro",
    text: SEEDANCE,
    image: { ...SEEDANCE, imageField: "input_urls" },
  },
];

const DEFAULT_KIE_VIDEO_MODEL = "kling-2.6/text-to-video";

function findKieVideoFamily(model: string): ModelFamily {
  const family = KIE_VIDEO_FAMILIES.find(
    (entry) => entry.textModel === model || entry.imageModel === model,
  );
  if (!family) {
    throw new Error(`Kie AI video generation does not support model ${model}.`);
  }
  return family;
}

function modeCapabilities(input?: ModelInput): VideoGenerationModeCapabilities {
  return {
    maxVideos: 1,
    maxDurationSeconds: input?.durations ? Math.max(...input.durations) : undefined,
    supportedDurationSeconds: input?.durations ?? [],
    aspectRatios: input?.aspectRatios ?? [],
    resolutions: input?.resolutions ?? [],
    supportsAspectRatio: Boolean(input?.aspectRatios),
    supportsResolution: Boolean(input?.resolutions),
    supportsAudio: Boolean(input?.audioField),
    supportsSize: false,
    supportsWatermark: false,
    providerOptions: {},
  };
}

function kieVideoCapabilities(family: ModelFamily): VideoGenerationProviderCapabilities {
  return {
    generate: modeCapabilities(family.text),
    imageToVideo: { ...modeCapabilities(family.image), enabled: true, maxInputImages: 1 },
    videoToVideo: { enabled: false },
  };
}

const BASE_URL = "https://api.kie.ai";
// The File Upload quickstart documents a separate host from Market jobs.
const UPLOAD_BASE_URL = "https://kieai.redpandaai.co";
const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;

function readKieData(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.code !== 200 || payload.success === false) {
    throw new Error(
      `Kie AI request failed: ${normalizeOptionalString(payload.msg) ?? `code ${String(payload.code)}`}`,
    );
  }
  if (!isRecord(payload.data)) {
    throw new Error("Kie AI response missing data.");
  }
  return payload.data;
}

function readTask(payload: Record<string, unknown>) {
  const data = readKieData(payload);
  switch (data.state) {
    case "waiting":
    case "queuing":
    case "generating":
    case "success":
      return data;
    case "fail": {
      const message = normalizeOptionalString(data.failMsg) ?? "generation failed";
      const code =
        typeof data.failCode === "string" || typeof data.failCode === "number"
          ? ` (${data.failCode})`
          : "";
      throw new Error(`Kie AI video generation failed${code}: ${message}`);
    }
    default:
      throw new Error(`Kie AI video status response has unknown state: ${String(data.state)}`);
  }
}

function readOutputUrls(data: Record<string, unknown>): string[] {
  let result: unknown = data.response;
  if (typeof data.resultJson === "string") {
    try {
      result = JSON.parse(data.resultJson);
    } catch (cause) {
      throw new Error("Kie AI video generation returned malformed resultJson.", { cause });
    }
  }
  if (!isRecord(result) || !Array.isArray(result.resultUrls) || !result.resultUrls.length) {
    throw new Error("Kie AI video generation completed without result URLs.");
  }
  return result.resultUrls.map((value: unknown) => {
    const url = normalizeOptionalString(value);
    if (!url) {
      throw new Error("Kie AI video generation returned a malformed result URL.");
    }
    return url;
  });
}

function remoteImageUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("Kie AI image-to-video requires a remote http(s) image URL or a local buffer.");
  }
  return url.href;
}

function imageUploadData(image: VideoGenerationSourceAsset, model: string): string {
  if (!image.buffer?.length) {
    throw new Error("Kie AI image-to-video input is missing image data.");
  }
  if (image.buffer.length > 10 * 1024 * 1024) {
    throw new Error("Kie AI image-to-video supports images up to 10 MB.");
  }
  const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
  const supported = model.startsWith("kling-")
    ? ["image/jpeg", "image/png"]
    : ["image/jpeg", "image/png", "image/webp"];
  if (!supported.includes(mimeType)) {
    throw new Error(`Kie AI ${model} requires ${supported.join(" or ")} image data.`);
  }
  return `data:${mimeType};base64,${image.buffer.toString("base64")}`;
}

export function buildKieVideoGenerationProvider(): VideoGenerationProvider {
  const models = [
    ...new Set(
      KIE_VIDEO_FAMILIES.flatMap((family) =>
        family.textModel ? [family.textModel, family.imageModel] : [family.imageModel],
      ),
    ),
  ];
  return {
    id: "kie",
    label: "Kie AI",
    defaultModel: DEFAULT_KIE_VIDEO_MODEL,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    models,
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "kie", ...ctx }),
    capabilities: kieVideoCapabilities(findKieVideoFamily(DEFAULT_KIE_VIDEO_MODEL)),
    catalogByModel: Object.fromEntries(
      models.map((model) => {
        const family = findKieVideoFamily(model);
        return [
          model,
          {
            modes: family.textModel ? ["generate", "imageToVideo"] : ["imageToVideo"],
            capabilities: kieVideoCapabilities(family),
          },
        ];
      }),
    ),
    resolveModelCapabilities: ({ model }) => kieVideoCapabilities(findKieVideoFamily(model)),
    async generateVideo(req) {
      if (req.inputVideos?.length || req.inputAudios?.length) {
        throw new Error(
          "Kie AI video generation does not support video or audio reference inputs.",
        );
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Kie AI video generation supports at most one input image.");
      }
      const image = req.inputImages?.[0];
      if (image?.role && image.role !== "first_frame") {
        throw new Error("Kie AI image-to-video supports only an ordinary or first_frame image.");
      }
      const family = findKieVideoFamily(req.model.trim() || DEFAULT_KIE_VIDEO_MODEL);
      const spec = image ? family.image : family.text;
      const model = image ? family.imageModel : family.textModel;
      if (!spec || !model) {
        throw new Error(`Kie AI model ${req.model} requires one input image.`);
      }
      const minPromptLength = spec.minPromptLength ?? 1;
      if (req.prompt.trim().length < minPromptLength || req.prompt.length > spec.maxPromptLength) {
        throw new Error(
          `Kie AI ${model} requires a prompt of ${minPromptLength}-${spec.maxPromptLength} characters.`,
        );
      }
      const input: Record<string, unknown> = { prompt: req.prompt };
      if (spec.durations?.length) {
        const requested = req.durationSeconds;
        const duration =
          typeof requested === "number" && Number.isFinite(requested)
            ? spec.durations.reduce((best, next) =>
                Math.abs(next - requested) < Math.abs(best - requested) ? next : best,
              )
            : spec.durations[0];
        input.duration = spec.numericDuration ? duration : String(duration);
      }
      if (spec.aspectRatios) {
        input.aspect_ratio = spec.aspectRatios.includes(req.aspectRatio ?? "")
          ? req.aspectRatio
          : spec.aspectRatios[0];
      }
      if (spec.resolutions) {
        const requested = req.resolution?.toUpperCase();
        const resolution =
          spec.resolutions.find((value) => value === requested) ?? spec.resolutions[0];
        input.resolution = spec.uppercaseResolution ? resolution : resolution?.toLowerCase();
        if (model.startsWith("hailuo/2-3-") && resolution === "1080P" && input.duration === "10") {
          throw new Error(
            "Kie AI Hailuo 2.3 supports 1080P only at 6 seconds; use 768P for 10 seconds.",
          );
        }
      }
      if (spec.audioField) {
        input[spec.audioField] = req.audio ?? false;
      }
      const imageField = spec.imageField;
      const imageUrl = image?.url ? remoteImageUrl(image.url) : undefined;
      const base64Data = image && !imageUrl ? imageUploadData(image, model) : undefined;
      const auth = await resolveApiKeyForProvider({
        provider: "kie",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Kie AI API key missing");
      }
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        label: "Kie AI video generation",
      });
      const timeoutMs = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const configured = req.cfg.models?.providers?.kie;
      const request = sanitizeConfiguredModelProviderRequest(configured?.request);
      const defaultHeaders = {
        Authorization: `Bearer ${auth.apiKey}`,
        "Content-Type": "application/json",
      };
      const http = resolveProviderHttpRequestConfig({
        baseUrl: normalizeOptionalString(configured?.baseUrl) ?? BASE_URL,
        defaultBaseUrl: BASE_URL,
        defaultHeaders,
        request,
        provider: "kie",
        capability: "video",
        transport: "http",
      });
      const post = async (url: string, body: Record<string, unknown>, policy: typeof http) => {
        return readKieData(
          await postJsonResponse({
            url,
            body,
            headers: policy.headers,
            timeoutMs: timeoutMs(),
            fetchFn: fetch,
            allowPrivateNetwork: policy.allowPrivateNetwork,
            dispatcherPolicy: policy.dispatcherPolicy,
            errorLabel: "Kie AI request failed",
            responseLabel: "Kie AI response",
            readOptions: { timeoutMs },
            objectResponse: true,
          }),
        );
      };
      if (image && imageField) {
        let url = imageUrl;
        if (base64Data) {
          const uploadHttp = resolveProviderHttpRequestConfig({
            baseUrl: UPLOAD_BASE_URL,
            defaultBaseUrl: UPLOAD_BASE_URL,
            defaultHeaders,
            request,
            provider: "kie",
            capability: "video",
            transport: "http",
          });
          const uploaded = await post(
            `${uploadHttp.baseUrl}/api/file-base64-upload`,
            {
              base64Data,
              uploadPath: "openclaw/video-inputs",
            },
            uploadHttp,
          );
          url = normalizeOptionalString(uploaded.downloadUrl);
          if (!url) {
            throw new Error("Kie AI image upload response missing downloadUrl.");
          }
          url = remoteImageUrl(url);
        }
        input[imageField] = imageField === "image_url" ? url : [url];
      }
      const submitted = await post(
        `${http.baseUrl}/api/v1/jobs/createTask`,
        { model, input },
        http,
      );
      const taskId = normalizeOptionalString(submitted.taskId);
      if (!taskId) {
        throw new Error("Kie AI video generation response missing taskId.");
      }
      const completed = await pollProviderOperationJson<Record<string, unknown>>({
        url: `${http.baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
        headers: http.headers,
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        allowPrivateNetwork: http.allowPrivateNetwork,
        dispatcherPolicy: http.dispatcherPolicy,
        maxAttempts: Math.ceil((req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / POLL_INTERVAL_MS),
        pollIntervalMs: POLL_INTERVAL_MS,
        requestFailedMessage: "Kie AI video status request failed",
        timeoutMessage: `Kie AI video generation task ${taskId} did not finish in time`,
        isComplete: (payload) => readTask(payload).state === "success",
      });
      const outputUrls = readOutputUrls(readKieData(completed));
      const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "video");
      const videos: GeneratedVideoAsset[] = [];
      for (const [index, url] of outputUrls.entries()) {
        videos.push(
          await downloadGeneratedVideoAsset({
            url,
            timeoutMs,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            fetchFn: fetch,
            provider: "kie",
            label: "Kie AI generated video download",
            requestFailedMessage: "Kie AI generated video download failed",
            index,
            maxBytes,
            validateBinaryResponse: true,
            metadata: { sourceUrl: url },
          }),
        );
      }
      return { videos, model, metadata: { taskId, outputUrls } };
    },
  };
}
