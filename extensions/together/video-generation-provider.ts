import { resolveImageSourceUrl } from "openclaw/plugin-sdk/image-generation";
import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  normalizeBaseUrl,
  pollProviderOperationJson,
  postJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderApiKeyHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { TOGETHER_BASE_URL } from "./models.js";

const DEFAULT_TOGETHER_VIDEO_MODEL = "Wan-AI/wan2.7-t2v";
const TOGETHER_IMAGE_TO_VIDEO_MODELS = new Set(["Wan-AI/wan2.7-i2v"]);
const TOGETHER_VIDEO_BASE_URL = "https://api.together.xyz/v2";
const DEFAULT_TIMEOUT_MS = 120_000;
// Live Wan 2.7 generations have taken about 10 minutes to complete.
const DEFAULT_OPERATION_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 240;
const TOGETHER_MIN_DURATION_SECONDS = 1;
const TOGETHER_MAX_DURATION_SECONDS = 10;
// Wan's documented minimum is 2s; retain OpenClaw's existing 10s ceiling.
const TOGETHER_WAN_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const TOGETHER_MODEL_DURATIONS = {
  "Wan-AI/wan2.7-t2v": TOGETHER_WAN_DURATIONS,
  "Wan-AI/wan2.7-i2v": TOGETHER_WAN_DURATIONS,
};
// https://docs.together.ai/docs/wan2.7-quickstart#prompting-tips
const TOGETHER_WAN_SIZES: Record<string, { resolution: string; ratio: string }> = {
  "1280x720": { resolution: "720P", ratio: "16:9" },
  "1920x1080": { resolution: "1080P", ratio: "16:9" },
  "720x1280": { resolution: "720P", ratio: "9:16" },
  "1080x1920": { resolution: "1080P", ratio: "9:16" },
  "960x960": { resolution: "720P", ratio: "1:1" },
  "1440x1440": { resolution: "1080P", ratio: "1:1" },
  "1104x832": { resolution: "720P", ratio: "4:3" },
  "1648x1248": { resolution: "1080P", ratio: "4:3" },
  "832x1104": { resolution: "720P", ratio: "3:4" },
  "1248x1648": { resolution: "1080P", ratio: "3:4" },
};

type TogetherVideoResponse = {
  id?: string;
  model?: string;
  status?: "in_progress" | "completed" | "failed";
  error?: {
    code?: string;
    message?: string;
  } | null;
  outputs?:
    | {
        video_url?: string;
        url?: string;
      }
    | Array<{
        video_url?: string;
        url?: string;
      }>;
};

function resolveTogetherVideoBaseUrl(req: VideoGenerationRequest): string {
  const configuredBaseUrl = normalizeOptionalString(req.cfg?.models?.providers?.together?.baseUrl);
  if (
    !configuredBaseUrl ||
    normalizeBaseUrl(configuredBaseUrl) === normalizeBaseUrl(TOGETHER_BASE_URL)
  ) {
    return TOGETHER_VIDEO_BASE_URL;
  }
  return configuredBaseUrl;
}

function extractTogetherVideoUrl(payload: TogetherVideoResponse): string | undefined {
  if (Array.isArray(payload.outputs)) {
    for (const entry of payload.outputs) {
      const url = normalizeOptionalString(entry.video_url) ?? normalizeOptionalString(entry.url);
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  return (
    normalizeOptionalString(payload.outputs?.video_url) ??
    normalizeOptionalString(payload.outputs?.url)
  );
}

function readTogetherVideoFailureMessage(payload: TogetherVideoResponse): string | undefined {
  return payload.status === "failed"
    ? (normalizeOptionalString(payload.error?.message) ?? "Together video generation failed")
    : undefined;
}

function resolveTogetherDurationSeconds(value: unknown, min: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const duration = asSafeIntegerInRange(Math.round(value), {
    min,
    max: TOGETHER_MAX_DURATION_SECONDS,
  });
  return duration === undefined ? undefined : String(duration);
}

export function buildTogetherVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "together",
    label: "Together",
    defaultModel: DEFAULT_TOGETHER_VIDEO_MODEL,
    models: [DEFAULT_TOGETHER_VIDEO_MODEL, "Wan-AI/wan2.7-i2v", "minimax/hailuo-02"],
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "together", ...ctx }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: TOGETHER_MAX_DURATION_SECONDS,
        supportedDurationSecondsByModel: TOGETHER_MODEL_DURATIONS,
        supportsSize: true,
      },
      imageToVideo: {
        enabled: true,
        maxInputImagesByModel: {
          "Wan-AI/wan2.7-i2v": 1,
        },
        maxDurationSeconds: TOGETHER_MAX_DURATION_SECONDS,
        supportedDurationSecondsByModel: TOGETHER_MODEL_DURATIONS,
        supportsSize: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Together video generation does not support video reference inputs.");
      }
      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveProviderApiKeyHttpRequestConfig({
          req,
          missingApiKeyMessage: "Together API key missing",
          baseUrl: resolveTogetherVideoBaseUrl(req),
          defaultBaseUrl: TOGETHER_VIDEO_BASE_URL,
          allowPrivateNetwork: false,
          provider: "together",
          capability: "video",
        });
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Together video generation",
      });
      const model = normalizeOptionalString(req.model) ?? DEFAULT_TOGETHER_VIDEO_MODEL;
      const isWanModel =
        model === DEFAULT_TOGETHER_VIDEO_MODEL || TOGETHER_IMAGE_TO_VIDEO_MODELS.has(model);
      const body: Record<string, unknown> = {
        model,
        prompt: req.prompt,
      };
      const duration = resolveTogetherDurationSeconds(
        req.durationSeconds,
        isWanModel ? TOGETHER_WAN_DURATIONS[0] : TOGETHER_MIN_DURATION_SECONDS,
      );
      if (duration !== undefined) {
        body.seconds = duration;
      }
      const size = normalizeOptionalString(req.size);
      if (size && isWanModel) {
        const dimensions = TOGETHER_WAN_SIZES[size];
        if (!dimensions) {
          throw new Error(
            `Together video model ${model} does not support size ${size}. Use ${Object.keys(TOGETHER_WAN_SIZES).join(", ")} or omit size.`,
          );
        }
        Object.assign(body, dimensions);
      } else if (size) {
        const match = /^(\d+)x(\d+)$/u.exec(size);
        if (match) {
          body.width = Number.parseInt(match[1] ?? "", 10);
          body.height = Number.parseInt(match[2] ?? "", 10);
        }
      }
      if (req.inputImages?.[0]) {
        if (!TOGETHER_IMAGE_TO_VIDEO_MODELS.has(model)) {
          throw new Error(
            `Together video model ${model} does not support image reference inputs. Use Wan-AI/wan2.7-i2v or omit input images.`,
          );
        }
        const value = resolveImageSourceUrl(
          req.inputImages[0],
          "Together reference image is missing image data.",
        );
        body.media = { frame_images: [{ input_image: value, frame: "first" }] };
      }
      const submitted = await postJsonResponse<TogetherVideoResponse>({
        url: `${baseUrl}/videos`,
        headers,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        errorLabel: "Together video generation failed",
      });
      const failureMessage = readTogetherVideoFailureMessage(submitted);
      if (failureMessage) {
        throw new Error(failureMessage);
      }
      const videoId = normalizeOptionalString(submitted.id);
      if (!videoId) {
        throw new Error("Together video generation response missing id");
      }
      const completed =
        submitted.status === "completed"
          ? submitted
          : await pollProviderOperationJson<TogetherVideoResponse>({
              url: `${baseUrl}/videos/${videoId}`,
              headers,
              deadline:
                deadline.deadlineAtMs === undefined
                  ? createProviderOperationDeadline({
                      timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
                      label: `Together video generation task ${videoId}`,
                    })
                  : { ...deadline, label: `Together video generation task ${videoId}` },
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              fetchFn,
              maxAttempts: MAX_POLL_ATTEMPTS,
              pollIntervalMs: POLL_INTERVAL_MS,
              requestFailedMessage: "Together video status request failed",
              timeoutMessage: `Together video generation task ${videoId} did not finish in time`,
              isComplete: (payload) => payload.status === "completed",
              getFailureMessage: readTogetherVideoFailureMessage,
            });
      const videoUrl = extractTogetherVideoUrl(completed);
      if (!videoUrl) {
        throw new Error("Together video generation completed without an output URL");
      }
      const video = await downloadGeneratedVideoAsset({
        url: videoUrl,
        timeoutMs: createProviderOperationTimeoutResolver({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        fetchFn,
        provider: "together",
        label: "Together generated video download",
        requestFailedMessage: "Together generated video download failed",
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
        validateBinaryResponse: true,
        chunkTimeoutMs: 0,
      });
      return {
        videos: [video],
        model: completed.model ?? req.model ?? DEFAULT_TOGETHER_VIDEO_MODEL,
        metadata: {
          videoId,
          status: completed.status,
          videoUrl,
        },
      };
    },
  };
}
