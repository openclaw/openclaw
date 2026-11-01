import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperationJson,
  postJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderApiKeyHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeVideoGenerationDuration,
  type GeneratedVideoAsset,
  type VideoGenerationRequest,
  type VideoGenerationResult,
  type VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
const DEFAULT_RUNWAY_MODEL = "gen4.5";
const RUNWAY_API_VERSION = "2024-11-06";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const MAX_DURATION_SECONDS = 10;

type RunwayTaskStatus = "PENDING" | "RUNNING" | "THROTTLED" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type RunwayTaskDetailResponse = {
  status?: unknown;
  output?: unknown;
  failure?: unknown;
};

type RunwaySourceAsset = Pick<VideoGenerationSourceAsset, "buffer" | "mimeType" | "url">;

const TEXT_ONLY_MODELS = new Set(["gen4.5", "veo3.1", "veo3.1_fast", "veo3"]);
const IMAGE_MODELS = new Set([
  "gen4.5",
  "gen4_turbo",
  "gen3a_turbo",
  "veo3.1",
  "veo3.1_fast",
  "veo3",
]);
const VIDEO_MODELS = new Set(["gen4_aleph"]);
const RUNWAY_TEXT_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const RUNWAY_EDIT_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "3:4", "4:3", "21:9"] as const;

function readRunwayTaskStatus(payload: RunwayTaskDetailResponse): RunwayTaskStatus {
  const status = normalizeOptionalString(payload.status);
  switch (status) {
    case "PENDING":
    case "RUNNING":
    case "THROTTLED":
    case "SUCCEEDED":
    case "FAILED":
    case "CANCELLED":
      return status;
    case undefined:
      throw new Error("Runway video status response missing task status");
    default:
      throw new Error(`Runway video status response returned unknown task status: ${status}`);
  }
}

function readRunwayFailureMessage(failure: unknown): string | undefined {
  if (typeof failure === "string") {
    return normalizeOptionalString(failure);
  }
  if (isRecord(failure)) {
    return normalizeOptionalString(failure.message);
  }
  return undefined;
}

function resolveSourceUri(
  asset: RunwaySourceAsset | undefined,
  fallbackMimeType: string,
): string | undefined {
  if (!asset) {
    return undefined;
  }
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return url;
  }
  if (!asset.buffer) {
    return undefined;
  }
  const mimeType = normalizeOptionalString(asset.mimeType) ?? fallbackMimeType;
  return `data:${mimeType};base64,${asset.buffer.toString("base64")}`;
}

const RUNWAY_RATIO_SIZES = new Map([
  ["9:16", "720:1280"],
  ["16:9", "1280:720"],
  ["1:1", "960:960"],
  ["3:4", "832:1104"],
  ["4:3", "1104:832"],
  ["21:9", "1584:672"],
]);

function buildCreateBody(
  req: VideoGenerationRequest,
  endpoint: "/v1/text_to_video" | "/v1/image_to_video" | "/v1/video_to_video",
): Record<string, unknown> {
  const normalizedDuration = normalizeVideoGenerationDuration({
    durationSeconds: req.durationSeconds,
  });
  const duration =
    normalizedDuration === undefined || !Number.isSafeInteger(req.durationSeconds)
      ? 5
      : Math.max(2, Math.min(MAX_DURATION_SECONDS, normalizedDuration));
  const hasReferenceInput =
    (req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0;
  const ratio =
    normalizeOptionalString(req.size) ||
    RUNWAY_RATIO_SIZES.get(normalizeOptionalString(req.aspectRatio) ?? "") ||
    "1280:720";
  if (!hasReferenceInput && ratio !== "1280:720" && ratio !== "720:1280") {
    throw new Error("Runway text-to-video currently supports only 16:9 or 9:16 output ratios.");
  }
  const model = normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL;
  if (endpoint !== "/v1/video_to_video") {
    const imageToVideo = endpoint === "/v1/image_to_video";
    const models = imageToVideo ? IMAGE_MODELS : TEXT_ONLY_MODELS;
    const mode = imageToVideo ? "image-to-video" : "text-to-video";
    if (!models.has(model)) {
      throw new Error(
        `Runway ${mode} does not support model ${model}. Use one of: ${[...models].join(", ")}.`,
      );
    }
    const promptImage = imageToVideo
      ? resolveSourceUri(req.inputImages?.[0], "image/png")
      : undefined;
    if (imageToVideo && !promptImage) {
      throw new Error("Runway image-to-video input is missing image data.");
    }
    return {
      model,
      promptText: req.prompt,
      ...(imageToVideo ? { promptImage } : {}),
      ratio,
      duration,
    };
  }

  if (!VIDEO_MODELS.has(model)) {
    throw new Error("Runway video-to-video currently requires model gen4_aleph.");
  }
  const videoUri = resolveSourceUri(req.inputVideos?.[0], "video/mp4");
  if (!videoUri) {
    throw new Error("Runway video-to-video input is missing video data.");
  }
  return {
    model,
    promptText: req.prompt,
    videoUri,
    ratio,
  };
}

export default definePluginEntry({
  id: "runway",
  name: "Runway Provider",
  description: "Bundled Runway video provider plugin",
  register(api) {
    api.registerProvider({
      id: "runway",
      label: "Runway",
      docsPath: "/providers/runway",
      envVars: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "runway",
          methodId: "api-key",
          label: "Runway API key",
          optionKey: "runwayApiKey",
          flagName: "--runway-api-key",
          envVar: "RUNWAYML_API_SECRET",
          promptMessage: "Enter Runway API key",
          wizard: {
            choiceId: "runway-api-key",
            choiceLabel: "Runway API key",
            groupId: "runway",
            groupLabel: "Runway",
            groupHint: "API key",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider({
      id: "runway",
      label: "Runway",
      defaultModel: DEFAULT_RUNWAY_MODEL,
      models: [
        "gen4.5",
        "gen4_turbo",
        "gen4_aleph",
        "gen3a_turbo",
        "veo3.1",
        "veo3.1_fast",
        "veo3",
      ],
      isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "runway", ...ctx }),
      capabilities: {
        generate: {
          maxVideos: 1,
          maxDurationSeconds: MAX_DURATION_SECONDS,
          aspectRatios: RUNWAY_TEXT_ASPECT_RATIOS,
          supportsAspectRatio: true,
        },
        imageToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputImages: 1,
          maxDurationSeconds: MAX_DURATION_SECONDS,
          aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
          supportsAspectRatio: true,
        },
        videoToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputVideos: 1,
          aspectRatios: RUNWAY_EDIT_ASPECT_RATIOS,
          supportsAspectRatio: true,
        },
      },
      async generateVideo(req): Promise<VideoGenerationResult> {
        const fetchFn = fetch;
        const imageCount = req.inputImages?.length ?? 0;
        const videoCount = req.inputVideos?.length ?? 0;
        if (imageCount > 0 && videoCount > 0) {
          throw new Error(
            "Runway video generation does not support image and video inputs together.",
          );
        }
        if (imageCount > 1 || videoCount > 1) {
          throw new Error(
            "Runway video generation supports at most one input image or one input video.",
          );
        }
        const endpoint =
          videoCount > 0
            ? "/v1/video_to_video"
            : imageCount > 0
              ? "/v1/image_to_video"
              : "/v1/text_to_video";
        const requestBody = buildCreateBody(req, endpoint);
        const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
          await resolveProviderApiKeyHttpRequestConfig({
            req,
            missingApiKeyMessage: "Runway API key missing",
            baseUrl: req.cfg?.models?.providers?.runway?.baseUrl,
            defaultBaseUrl: DEFAULT_RUNWAY_BASE_URL,
            request: sanitizeConfiguredModelProviderRequest(
              req.cfg?.models?.providers?.runway?.request,
            ),
            defaultHeaders: {
              "X-Runway-Version": RUNWAY_API_VERSION,
            },
            provider: "runway",
            capability: "video",
          });
        const deadline = createProviderOperationDeadline({
          timeoutMs: req.timeoutMs,
          label: "Runway video generation",
        });
        const submitted = await postJsonResponse({
          url: `${baseUrl}${endpoint}`,
          headers,
          body: requestBody,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
          errorLabel: "Runway video generation failed",
          objectResponse: true,
        });
        const taskId = normalizeOptionalString(submitted.id);
        if (!taskId) {
          throw new Error("Runway video generation response missing task id");
        }
        const completed = await pollProviderOperationJson<RunwayTaskDetailResponse>({
          url: `${baseUrl}/v1/tasks/${taskId}`,
          headers,
          deadline:
            deadline.deadlineAtMs === undefined
              ? createProviderOperationDeadline({
                  timeoutMs: DEFAULT_TIMEOUT_MS,
                  label: `Runway video generation task ${taskId}`,
                })
              : { ...deadline, label: `Runway video generation task ${taskId}` },
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          fetchFn,
          ssrfPolicy: { allowPrivateNetwork },
          dispatcherPolicy,
          maxAttempts: MAX_POLL_ATTEMPTS,
          pollIntervalMs: POLL_INTERVAL_MS,
          requestFailedMessage: "Runway video status request failed",
          timeoutMessage: `Runway video generation task ${taskId} did not finish in time`,
          isComplete: (payload) => readRunwayTaskStatus(payload) === "SUCCEEDED",
          getFailureMessage: (payload) => {
            const status = readRunwayTaskStatus(payload);
            return status === "FAILED" || status === "CANCELLED"
              ? readRunwayFailureMessage(payload.failure) ||
                  `Runway video generation ${normalizeLowercaseStringOrEmpty(status)}`
              : undefined;
          },
        });
        if (!Array.isArray(completed.output)) {
          throw new Error("Runway video generation completed with malformed output URLs");
        }
        const outputUrls = normalizeTrimmedStringList(completed.output);
        if (!outputUrls.length) {
          throw new Error("Runway video generation completed without output URLs");
        }

        const timeoutMs = createProviderOperationTimeoutResolver({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        });
        const maxBytes = resolveGeneratedMediaMaxBytes(req.cfg, "video");
        const videos: GeneratedVideoAsset[] = [];
        for (const [index, url] of outputUrls.entries()) {
          videos.push(
            await downloadGeneratedVideoAsset({
              url,
              timeoutMs,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              fetchFn,
              provider: "runway",
              label: "Runway generated video download",
              requestFailedMessage: "Runway generated video download failed",
              index,
              maxBytes,
              validateBinaryResponse: true,
              metadata: { sourceUrl: url },
              dispatcherPolicy,
            }),
          );
        }
        return {
          videos,
          model: normalizeOptionalString(req.model) ?? DEFAULT_RUNWAY_MODEL,
          metadata: {
            taskId,
            status: normalizeOptionalString(completed.status),
            endpoint,
            outputUrls,
          },
        };
      },
    });
  },
});
