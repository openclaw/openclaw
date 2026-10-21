import { randomUUID } from "node:crypto";
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  pollProviderOperationJson,
  postJsonRequest,
  postMultipartRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  asFiniteNumber,
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeVideoGenerationDuration,
  type VideoGenerationModeCapabilities,
  type VideoGenerationProvider,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_PIXVERSE_MODEL_ID,
  DEFAULT_PIXVERSE_REGION,
  normalizePixVerseRegion,
  PIXVERSE_BASE_URL_BY_REGION,
  PIXVERSE_PROVIDER_ID,
} from "./constants.js";

const DEFAULT_PIXVERSE_BASE_URL = PIXVERSE_BASE_URL_BY_REGION[DEFAULT_PIXVERSE_REGION];
const DEFAULT_PIXVERSE_QUALITY = "540p";
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180;
const MAX_DURATION_SECONDS = 15;
const PIXVERSE_SEED_MAX = 2_147_483_647;
const PIXVERSE_VIDEO_MODELS = ["v6", "c1"] as const;
const PIXVERSE_TEXT_ASPECT_RATIOS = [
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
] as const;
const PIXVERSE_QUALITIES = ["360p", "540p", "720p", "1080p"] as const;

type PixVerseEnvelope<T> = {
  ErrCode?: unknown;
  ErrMsg?: unknown;
  Resp?: T;
};

type PixVerseUploadImageResponse = {
  img_id?: unknown;
};

type PixVerseVideoCreateResponse = {
  video_id?: unknown;
};

type PixVerseVideoResultResponse = {
  status?: unknown;
  url?: unknown;
  outputWidth?: unknown;
  outputHeight?: unknown;
  seed?: unknown;
  size?: unknown;
};

function readPixVerseSeed(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0, max: PIXVERSE_SEED_MAX });
}

function buildPixVerseHeaders(headers: Headers, contentType?: string): Headers {
  const next = new Headers(headers);
  next.set("Ai-trace-id", randomUUID());
  if (contentType) {
    next.set("Content-Type", contentType);
  } else {
    next.delete("Content-Type");
  }
  return next;
}

function readPixVerseSuccess<T>(payload: PixVerseEnvelope<T>, label: string): T {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label}: malformed JSON response`);
  }
  const code = asFiniteNumber(payload.ErrCode);
  if (code !== 0) {
    const message = normalizeOptionalString(payload.ErrMsg) ?? `ErrCode ${String(payload.ErrCode)}`;
    throw new Error(`${label}: ${message}`);
  }
  if (payload.Resp === undefined || payload.Resp === null) {
    throw new Error(`${label}: response missing Resp`);
  }
  return payload.Resp;
}

async function readPixVerseJson<T>(response: Response, label: string): Promise<T> {
  const payload = await readProviderJsonResponse<PixVerseEnvelope<T>>(response, label);
  return readPixVerseSuccess(payload, label);
}

function readPixVerseInteger(value: unknown, label: string): number {
  const integer = asSafeIntegerInRange(value, { min: 0 });
  if (integer === undefined) {
    throw new Error(label);
  }
  return integer;
}

function readPixVerseStatus(payload: PixVerseVideoResultResponse): number {
  return readPixVerseInteger(payload.status, "PixVerse video status response missing status");
}

function readPixVerseFailureMessage(payload: PixVerseVideoResultResponse): string | undefined {
  switch (readPixVerseStatus(payload)) {
    case 7:
      return "PixVerse video generation failed content moderation";
    case 8:
      return "PixVerse video generation failed";
    case 6:
      return "PixVerse video generation was deleted before completion";
    default:
      return undefined;
  }
}

function buildPixVerseModeCapabilities(imageToVideo = false): VideoGenerationModeCapabilities {
  return {
    maxVideos: 1,
    ...(imageToVideo ? { maxInputImages: 1 } : {}),
    maxDurationSeconds: MAX_DURATION_SECONDS,
    supportedDurationSeconds: Array.from({ length: MAX_DURATION_SECONDS }, (_, index) => index + 1),
    ...(!imageToVideo ? { aspectRatios: [...PIXVERSE_TEXT_ASPECT_RATIOS] } : {}),
    resolutions: ["360P", "540P", "720P", "1080P"],
    ...(!imageToVideo ? { supportsAspectRatio: true } : {}),
    supportsResolution: true,
    supportsAudio: true,
    providerOptions: {
      seed: "number",
      negative_prompt: "string",
      negativePrompt: "string",
      quality: "string",
      ...(imageToVideo ? { motion_mode: "string" as const, motionMode: "string" as const } : {}),
      camera_movement: "string",
      cameraMovement: "string",
      template_id: "number",
      templateId: "number",
    },
  };
}

export function buildPixVerseVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: PIXVERSE_PROVIDER_ID,
    label: "PixVerse",
    defaultModel: DEFAULT_PIXVERSE_MODEL_ID,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    models: [...PIXVERSE_VIDEO_MODELS],
    isConfiguredAsync: (ctx) =>
      isProviderApiKeyConfiguredAsync({ provider: PIXVERSE_PROVIDER_ID, ...ctx }),
    capabilities: {
      generate: buildPixVerseModeCapabilities(),
      imageToVideo: {
        enabled: true,
        ...buildPixVerseModeCapabilities(true),
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("PixVerse video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("PixVerse image-to-video supports at most one input image.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: PIXVERSE_PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("PixVerse API key missing");
      }

      const model =
        normalizeOptionalString(req.model)
          ?.replace(/^pixverse\//iu, "")
          .toLowerCase() || DEFAULT_PIXVERSE_MODEL_ID;
      const fetchFn = fetch;
      const providerConfig = req.cfg?.models?.providers?.[PIXVERSE_PROVIDER_ID];
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "PixVerse video generation",
      });
      let configuredBaseUrl = normalizeOptionalString(providerConfig?.baseUrl);
      if (!configuredBaseUrl) {
        const region = normalizeOptionalString(providerConfig?.region)?.toLowerCase();
        const normalized = normalizePixVerseRegion(region);
        if (!normalized && region !== undefined) {
          throw new Error(
            `Unsupported PixVerse API region "${region}". Use "international" or "cn".`,
          );
        }
        configuredBaseUrl = PIXVERSE_BASE_URL_BY_REGION[normalized ?? DEFAULT_PIXVERSE_REGION];
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: configuredBaseUrl,
          defaultBaseUrl: DEFAULT_PIXVERSE_BASE_URL,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            "API-KEY": auth.apiKey,
          },
          provider: PIXVERSE_PROVIDER_ID,
          capability: "video",
          transport: "http",
        });

      const image = req.inputImages?.[0];
      let imageId: number | undefined;
      if (image) {
        const uploadHeaders = buildPixVerseHeaders(headers);
        const form = new FormData();
        const imageUrl = normalizeOptionalString(image.url);
        if (imageUrl) {
          form.set("image_url", imageUrl);
        } else {
          if (!image.buffer) {
            throw new Error("PixVerse image-to-video input is missing image data.");
          }
          const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
          const extension = extensionForMime(mimeType)?.slice(1) ?? "png";
          const fileName = normalizeOptionalString(image.fileName) ?? `image.${extension}`;
          const file = new File([bufferToBlobPart(image.buffer)], fileName, { type: mimeType });
          form.set("image", file);
        }
        const upload = await postMultipartRequest({
          url: `${baseUrl}/image/upload`,
          headers: uploadHeaders,
          body: form,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        try {
          await assertOkOrThrowHttpError(upload.response, "PixVerse image upload failed");
          const uploaded = await readPixVerseJson<PixVerseUploadImageResponse>(
            upload.response,
            "PixVerse image upload failed",
          );
          imageId = readPixVerseInteger(
            uploaded.img_id,
            "PixVerse image upload response missing img_id",
          );
        } finally {
          await upload.release();
        }
      }

      const options = req.providerOptions ?? {};
      const duration = Math.min(
        MAX_DURATION_SECONDS,
        normalizeVideoGenerationDuration({ durationSeconds: req.durationSeconds }) ?? 5,
      );
      const requestedQuality =
        normalizeOptionalString(req.providerOptions?.quality) ??
        normalizeOptionalString(req.resolution) ??
        normalizeOptionalString(req.size);
      const normalizedQuality =
        requestedQuality?.toLowerCase() === "480p" ? "540p" : requestedQuality?.toLowerCase();
      const body: Record<string, unknown> = {
        duration,
        model,
        prompt: req.prompt,
        quality:
          normalizedQuality &&
          PIXVERSE_QUALITIES.includes(normalizedQuality as (typeof PIXVERSE_QUALITIES)[number])
            ? normalizedQuality
            : DEFAULT_PIXVERSE_QUALITY,
      };
      if (imageId !== undefined) {
        body.img_id = imageId;
        body.motion_mode =
          normalizeOptionalString(options.motion_mode) ??
          normalizeOptionalString(options.motionMode) ??
          "normal";
      } else {
        body.aspect_ratio = normalizeOptionalString(req.aspectRatio) ?? "16:9";
      }
      const negativePrompt =
        normalizeOptionalString(options.negative_prompt) ??
        normalizeOptionalString(options.negativePrompt);
      if (negativePrompt) {
        body.negative_prompt = negativePrompt;
      }
      const cameraMovement =
        normalizeOptionalString(options.camera_movement) ??
        normalizeOptionalString(options.cameraMovement);
      if (cameraMovement) {
        body.camera_movement = cameraMovement;
      }
      const templateId = asFiniteNumber(options.template_id) ?? asFiniteNumber(options.templateId);
      if (templateId != null) {
        body.template_id = templateId;
      }
      const seed = readPixVerseSeed(options.seed);
      if (seed !== undefined) {
        body.seed = seed;
      }
      if (req.audio !== undefined) {
        body.generate_audio_switch = req.audio;
      }

      const endpoint = imageId === undefined ? "/video/text/generate" : "/video/img/generate";
      const create = await postJsonRequest({
        url: `${baseUrl}${endpoint}`,
        headers: buildPixVerseHeaders(headers, "application/json"),
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
        await assertOkOrThrowHttpError(create.response, "PixVerse video generation failed");
        const submitted = await readPixVerseJson<PixVerseVideoCreateResponse>(
          create.response,
          "PixVerse video generation failed",
        );
        const videoId = readPixVerseInteger(
          submitted.video_id,
          "PixVerse video generation response missing video_id",
        );
        const readResult = (payload: PixVerseEnvelope<PixVerseVideoResultResponse>) =>
          readPixVerseSuccess(payload, "PixVerse video status request failed");
        const completedEnvelope = await pollProviderOperationJson<
          PixVerseEnvelope<PixVerseVideoResultResponse>
        >({
          url: `${baseUrl}/video/result/${videoId}`,
          headers: () => buildPixVerseHeaders(headers),
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          fetchFn,
          maxAttempts: MAX_POLL_ATTEMPTS,
          pollIntervalMs: POLL_INTERVAL_MS,
          requestFailedMessage: "PixVerse video status request failed",
          timeoutMessage: `PixVerse video generation task ${videoId} did not finish in time`,
          isComplete: (candidate) => readPixVerseStatus(readResult(candidate)) === 1,
          getFailureMessage: (candidate) => readPixVerseFailureMessage(readResult(candidate)),
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        const completed = readResult(completedEnvelope);
        const url = normalizeOptionalString(completed.url);
        if (!url) {
          throw new Error("PixVerse video generation completed without output URL");
        }
        const video = {
          url,
          mimeType: "video/mp4",
          fileName: "video-1.mp4",
          metadata: {
            sourceUrl: url,
            outputWidth: asFiniteNumber(completed.outputWidth),
            outputHeight: asFiniteNumber(completed.outputHeight),
          },
        };
        return {
          videos: [video],
          model,
          metadata: {
            endpoint,
            videoId,
            status: readPixVerseStatus(completed),
            seed: readPixVerseSeed(completed.seed),
            size: asFiniteNumber(completed.size),
          },
        };
      } finally {
        await create.release();
      }
    },
  };
}
