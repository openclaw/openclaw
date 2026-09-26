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
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  asSafeIntegerInRange,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { BYTEPLUS_BASE_URL } from "./models.js";

const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-1-0-pro-250528";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const BYTEPLUS_SEED_MAX = 2_147_483_647;
const BYTEPLUS_MIN_DURATION_SECONDS = 2;
const BYTEPLUS_MAX_DURATION_SECONDS = 12;

type BytePlusTaskResponse = {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  error?: unknown;
  content?: unknown;
  duration?: unknown;
  ratio?: unknown;
  resolution?: unknown;
};

type BytePlusTaskStatus = "running" | "failed" | "queued" | "succeeded" | "cancelled";

function readBytePlusTaskStatus(payload: BytePlusTaskResponse): BytePlusTaskStatus {
  const status = normalizeOptionalString(payload.status);
  switch (status) {
    case "running":
    case "failed":
    case "queued":
    case "succeeded":
    case "cancelled":
      return status;
    case undefined:
      throw new Error("BytePlus video status response missing task status");
    default:
      throw new Error(`BytePlus video status response returned unknown task status: ${status}`);
  }
}

function readBytePlusErrorMessage(error: unknown): string | undefined {
  return isRecord(error) ? normalizeOptionalString(error.message) : undefined;
}

function readBytePlusVideoUrl(payload: BytePlusTaskResponse): string {
  const content = payload.content;
  if (content !== undefined && !isRecord(content)) {
    throw new Error("BytePlus video generation completed with malformed content");
  }
  const videoUrl = normalizeOptionalString(content?.video_url);
  if (!videoUrl) {
    throw new Error("BytePlus video generation completed without a video URL");
  }
  return videoUrl;
}

function resolveBytePlusImageUrl(req: VideoGenerationRequest): string | undefined {
  const input = req.inputImages?.[0];
  if (!input) {
    return undefined;
  }
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("BytePlus reference image is missing image data.");
  }
  return toImageDataUrl({ ...input, buffer: input.buffer, defaultMimeType: "image/png" });
}

function resolveBytePlusDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return asSafeIntegerInRange(Math.round(value), {
    min: BYTEPLUS_MIN_DURATION_SECONDS,
    max: BYTEPLUS_MAX_DURATION_SECONDS,
  });
}

export function buildBytePlusVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "byteplus",
    label: "BytePlus",
    defaultModel: DEFAULT_BYTEPLUS_VIDEO_MODEL,
    models: [DEFAULT_BYTEPLUS_VIDEO_MODEL, "seedance-1-5-pro-251215"],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "byteplus", ...ctx }),
    capabilities: {
      providerOptions: {
        seed: "number",
        draft: "boolean",
        camera_fixed: "boolean",
      },
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
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "BytePlus video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl:
            normalizeOptionalString(req.cfg?.models?.providers?.byteplus?.baseUrl) ??
            BYTEPLUS_BASE_URL,
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
      const resolvedModel = normalizeOptionalString(req.model) || DEFAULT_BYTEPLUS_VIDEO_MODEL;

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
        model: resolvedModel,
        content,
      };
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      if (aspectRatio) {
        body.ratio = aspectRatio;
      }
      // Seedance API requires lowercase resolution values (e.g. "480p", "720p"); uppercase
      // variants like "480P" are rejected with InvalidParameter.
      const resolution = normalizeOptionalString(req.resolution)?.toLowerCase();
      if (resolution) {
        body.resolution = resolution;
      }
      const duration = resolveBytePlusDurationSeconds(req.durationSeconds);
      if (duration !== undefined) {
        body.duration = duration;
      }
      if (typeof req.audio === "boolean") {
        body.generate_audio = req.audio;
      }
      if (typeof req.watermark === "boolean") {
        body.watermark = req.watermark;
      }

      // draft=true forces 480p resolution for faster generation.
      const opts = req.providerOptions ?? {};
      const seed = asSafeIntegerInRange(opts.seed, { min: -1, max: BYTEPLUS_SEED_MAX });
      const draft = opts.draft === true;
      const cameraFixed = typeof opts.camera_fixed === "boolean" ? opts.camera_fixed : undefined;
      if (seed != null) {
        body.seed = seed;
      }
      if (draft && !body.resolution) {
        body.resolution = "480p";
      }
      if (cameraFixed != null) {
        body.camera_fixed = cameraFixed;
      }

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/contents/generations/tasks`,
        headers,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "BytePlus video generation failed");
        const submitted = await readProviderJsonObjectResponse(
          response,
          "BytePlus video generation failed",
        );
        const taskId = normalizeOptionalString(submitted.id);
        if (!taskId) {
          throw new Error("BytePlus video generation response missing task id");
        }
        const completed = await pollProviderOperationJson<BytePlusTaskResponse>({
          url: `${baseUrl}/contents/generations/tasks/${taskId}`,
          headers,
          deadline: createProviderOperationDeadline({
            timeoutMs: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
            label: `BytePlus video generation task ${taskId}`,
          }),
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          fetchFn,
          maxAttempts: MAX_POLL_ATTEMPTS,
          pollIntervalMs: POLL_INTERVAL_MS,
          requestFailedMessage: "BytePlus video status request failed",
          timeoutMessage: `BytePlus video generation task ${taskId} did not finish in time`,
          isComplete: (payload) => readBytePlusTaskStatus(payload) === "succeeded",
          getFailureMessage: (payload) => {
            const status = readBytePlusTaskStatus(payload);
            return status === "failed" || status === "cancelled"
              ? readBytePlusErrorMessage(payload.error) || "BytePlus video generation failed"
              : undefined;
          },
        });
        const videoUrl = readBytePlusVideoUrl(completed);
        const video = await downloadGeneratedVideoAsset({
          url: videoUrl,
          timeoutMs: createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          fetchFn,
          provider: "byteplus",
          label: "BytePlus generated video download",
          requestFailedMessage: "BytePlus generated video download failed",
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
          validateBinaryResponse: true,
        });
        return {
          videos: [video],
          model: normalizeOptionalString(completed.model) ?? resolvedModel,
          metadata: {
            taskId,
            status: normalizeOptionalString(completed.status),
            videoUrl,
            ratio: normalizeOptionalString(completed.ratio),
            resolution: normalizeOptionalString(completed.resolution),
            duration: asSafeIntegerInRange(completed.duration, {
              min: BYTEPLUS_MIN_DURATION_SECONDS,
              max: BYTEPLUS_MAX_DURATION_SECONDS,
            }),
          },
        };
      } finally {
        await release();
      }
    },
  };
}
