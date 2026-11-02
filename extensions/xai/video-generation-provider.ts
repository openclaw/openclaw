import { resolveImageSourceUrl } from "openclaw/plugin-sdk/image-generation";
import {
  downloadGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  executeProviderOperationWithRetry,
  fetchWithTimeoutGuarded,
  type ProviderOperationTimeoutMs,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperation,
  postJsonResponse,
  readProviderJsonObjectResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderApiKeyHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeVideoGenerationDuration,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_XAI_VIDEO_BASE_URL,
  DEFAULT_XAI_VIDEO_MODEL,
  XAI_VIDEO_ASPECT_RATIOS,
  XAI_VIDEO_DEFAULT_TIMEOUT_MS,
  createXaiVideoGenerationProviderMetadata,
  isXaiVideo15Model,
} from "./capability-provider-metadata-factory.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const XAI_VIDEO_MALFORMED_RESPONSE = "xAI video generation response malformed";
// xAI documents these as the only meaningful values; everything else (queued,
// processing, submitted, pending, in_progress, ...) means "keep polling".
const XAI_VIDEO_TERMINAL_FAILURE_STATUSES = new Set(["failed", "error", "expired", "cancelled"]);
const XAI_VIDEO_DEFAULT_DURATION_SECONDS = 8;
const XAI_VIDEO_DEFAULT_ASPECT_RATIO = "16:9";
const XAI_VIDEO_DEFAULT_RESOLUTION = "480p";

type XaiVideoStatusResponse = {
  status: string;
  videoUrl?: string;
  errorMessage?: string;
};

function xaiErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (error === undefined || error === null) {
    return undefined;
  }
  if (!isRecord(error)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return normalizeOptionalString(error.message);
}

function isReferenceImage(input: VideoGenerationSourceAsset): boolean {
  return normalizeOptionalString(input.role)?.toLowerCase() === "reference_image";
}

function resolveDurationSeconds(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  const duration = normalizeVideoGenerationDuration({ durationSeconds: value });
  if (duration === undefined) {
    return undefined;
  }
  return Math.max(min, Math.min(max, duration));
}

function resolveResolution(
  value: string | undefined,
  options?: { allow1080p?: boolean },
): "480p" | "720p" | "1080p" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "480p") {
    return "480p";
  }
  if (normalized === "720p") {
    return "720p";
  }
  if (normalized === "1080p") {
    return options?.allow1080p ? "1080p" : "720p";
  }
  return undefined;
}

function prepareCreateRequest(req: VideoGenerationRequest) {
  if (isXaiVideo15Model(req.model)) {
    if ((req.inputVideos?.length ?? 0) > 0) {
      throw new Error("xAI grok-imagine-video-1.5 does not support video inputs.");
    }
    const [inputImage, ...additionalImages] = req.inputImages ?? [];
    if (!inputImage || additionalImages.length > 0) {
      throw new Error("xAI grok-imagine-video-1.5 requires exactly one first-frame image.");
    }
    const role = normalizeOptionalString(inputImage.role)?.toLowerCase();
    if (role !== undefined && role !== "first_frame") {
      throw new Error("xAI grok-imagine-video-1.5 supports only an ordinary or first_frame image.");
    }
  }
  const inputImages = req.inputImages ?? [];
  const hasReferenceImages = inputImages.some(isReferenceImage);
  if (hasReferenceImages && !inputImages.every(isReferenceImage)) {
    throw new Error(
      "xAI reference-image video generation requires every image role to be reference_image.",
    );
  }
  if (!hasReferenceImages && inputImages.length > 1) {
    throw new Error("xAI image-to-video generation supports at most one first-frame image.");
  }
  if (hasReferenceImages && inputImages.length > 7) {
    throw new Error("xAI reference-image video generation supports at most 7 reference images.");
  }
  if ((req.inputVideos?.length ?? 0) > 1) {
    throw new Error("xAI video generation supports at most one input video.");
  }
  if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
    throw new Error("xAI video generation does not support image and video inputs together.");
  }

  const body: Record<string, unknown> = {
    // Aliases are API-owned routing choices. Preserve the selected identifier
    // instead of silently pinning it to the canonical 1.5 model.
    model: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
    prompt: req.prompt,
  };

  if ((req.inputVideos?.length ?? 0) > 0) {
    const duration = resolveDurationSeconds(req.durationSeconds, 2, 10);
    const inputVideo = req.inputVideos?.[0];
    const videoUrl = inputVideo ? normalizeOptionalString(inputVideo.url) : undefined;
    if (inputVideo && !videoUrl) {
      throw new Error(
        inputVideo.buffer
          ? "xAI video editing currently requires a remote mp4 URL input."
          : "xAI video editing input is missing video data.",
      );
    }
    body.video = { url: videoUrl };
    if (duration !== undefined) {
      body.duration = duration;
    }
    return {
      body,
      mode: duration === undefined ? "edit" : "extend",
      endpoint: duration === undefined ? "/videos/edits" : "/videos/extensions",
    };
  }

  const inputImage = hasReferenceImages ? undefined : inputImages[0];
  const imageUrl = resolveImageSourceUrl(
    inputImage,
    "xAI image-to-video input is missing image data.",
  );
  if (hasReferenceImages) {
    body.reference_images = inputImages.map((image) => ({
      url: resolveImageSourceUrl(image, "xAI image-to-video input is missing image data."),
    }));
  } else if (imageUrl) {
    body.image = { url: imageUrl };
  }
  body.duration =
    resolveDurationSeconds(req.durationSeconds, 1, hasReferenceImages ? 10 : 15) ??
    XAI_VIDEO_DEFAULT_DURATION_SECONDS;
  const requestedAspectRatio = normalizeOptionalString(req.aspectRatio);
  const aspectRatio =
    requestedAspectRatio && XAI_VIDEO_ASPECT_RATIOS.has(requestedAspectRatio)
      ? requestedAspectRatio
      : undefined;
  // Image-to-video inherits the source frame's ratio when callers omit it;
  // text-to-video retains xAI's 16:9 default.
  if (aspectRatio || !imageUrl) {
    body.aspect_ratio = aspectRatio ?? XAI_VIDEO_DEFAULT_ASPECT_RATIO;
  }
  body.resolution =
    resolveResolution(req.resolution, {
      allow1080p: !hasReferenceImages && isXaiVideo15Model(req.model),
    }) ?? XAI_VIDEO_DEFAULT_RESOLUTION;
  return {
    body,
    mode: hasReferenceImages ? "referenceToVideo" : "generate",
    endpoint: "/videos/generations",
  };
}

export function buildXaiVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createXaiVideoGenerationProviderMetadata({ isProviderApiKeyConfiguredAsync }),
    async generateVideo(req) {
      // Validate provider/model mode constraints before auth or HTTP setup so
      // unsupported 1.5 requests cannot be submitted and billed accidentally.
      const { body, endpoint, mode } = prepareCreateRequest(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveProviderApiKeyHttpRequestConfig({
          req,
          missingApiKeyMessage: "xAI API key missing",
          baseUrl: req.cfg?.models?.providers?.xai?.baseUrl,
          defaultBaseUrl: DEFAULT_XAI_VIDEO_BASE_URL,
          request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.xai?.request),
          provider: "xai",
          capability: "video",
        });
      const fetchXaiVideoResponse = async (params: {
        url: string;
        init: RequestInit;
        stage: "poll" | "download";
        requestFailedMessage: string;
        auditContext: string;
        timeoutMs?: ProviderOperationTimeoutMs;
      }) => {
        return await executeProviderOperationWithRetry({
          provider: "xai",
          stage: params.stage,
          operation: async () => {
            const result = await fetchWithTimeoutGuarded(
              params.url,
              params.init,
              resolvePositiveTimerTimeoutMs(
                typeof params.timeoutMs === "function" ? params.timeoutMs() : params.timeoutMs,
                XAI_VIDEO_DEFAULT_TIMEOUT_MS,
              ),
              fetch,
              {
                ...(allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
                ...(dispatcherPolicy ? { dispatcherPolicy } : {}),
                auditContext: params.auditContext,
              },
            );
            try {
              await assertOkOrThrowHttpError(result.response, params.requestFailedMessage);
              return result;
            } catch (error) {
              await result.release();
              throw error;
            }
          },
        });
      };
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "xAI video generation",
      });
      // Per-submit idempotency key prevents accidental double-charging if
      // the request is replayed. Polls intentionally reuse `headers` without it.
      const submitHeaders = new Headers(headers);
      submitHeaders.set("x-idempotency-key", crypto.randomUUID());
      const submitted = await postJsonResponse({
        url: `${baseUrl}${endpoint}`,
        errorLabel: "xAI video generation failed",
        responseLabel: "xAI video generation response",
        objectResponse: true,
        readOptions: { malformedResponseError: XAI_VIDEO_MALFORMED_RESPONSE },
        headers: submitHeaders,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        }),
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      const submitError = xaiErrorMessage(submitted);
      const requestId = normalizeOptionalString(submitted.request_id);
      if (!requestId) {
        throw new Error(submitError ?? "xAI video generation response missing request_id");
      }
      const pollDeadline = createProviderOperationDeadline({
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        }),
        label: `xAI video generation request ${requestId}`,
      });
      const completed = await pollProviderOperation<XaiVideoStatusResponse>({
        maxAttempts: MAX_POLL_ATTEMPTS,
        timeoutMessage: `xAI video generation task ${requestId} did not finish in time`,
        wait: () =>
          waitProviderOperationPollInterval({
            deadline: pollDeadline,
            pollIntervalMs: POLL_INTERVAL_MS,
          }),
        read: async () => {
          const { response: pollResponse, release: releasePoll } = await fetchXaiVideoResponse({
            url: `${baseUrl}/videos/${requestId}`,
            stage: "poll",
            requestFailedMessage: "xAI video status request failed",
            auditContext: "xai-video-status",
            init: {
              method: "GET",
              headers,
            },
            timeoutMs: createProviderOperationTimeoutResolver({
              deadline: pollDeadline,
              defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
            }),
          });
          try {
            const payload = await readProviderJsonObjectResponse(
              pollResponse,
              "xAI video generation response",
              {
                malformedResponseError: XAI_VIDEO_MALFORMED_RESPONSE,
              },
            );
            const video = payload.video;
            if (video !== undefined && video !== null && !isRecord(video)) {
              throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
            }
            return {
              status: normalizeOptionalString(payload.status) ?? "",
              videoUrl: isRecord(video) ? normalizeOptionalString(video.url) : undefined,
              errorMessage: xaiErrorMessage(payload),
            };
          } finally {
            await releasePoll();
          }
        },
        isComplete: (payload) => payload.status.toLowerCase() === "done",
        getFailureMessage: (payload) => {
          const status = payload.status.toLowerCase();
          return XAI_VIDEO_TERMINAL_FAILURE_STATUSES.has(status)
            ? (payload.errorMessage ?? `xAI video generation ${status}`)
            : undefined;
        },
      });
      const videoUrl = completed.videoUrl;
      if (!videoUrl) {
        throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
      }
      const video = await downloadGeneratedVideoAsset({
        url: videoUrl,
        timeoutMs: createProviderOperationTimeoutResolver({
          deadline,
          defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        }),
        defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        provider: "xai",
        label: "xAI generated video download",
        requestFailedMessage: "xAI generated video download failed",
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
        validateBinaryResponse: true,
        chunkTimeoutMs: 0,
        fetchResponse: async ({ timeoutMs }) =>
          await fetchXaiVideoResponse({
            url: videoUrl,
            stage: "download",
            requestFailedMessage: "xAI generated video download failed",
            auditContext: "xai-video-download",
            init: { method: "GET" },
            timeoutMs,
          }),
      });
      return {
        videos: [video],
        model: normalizeOptionalString(req.model) ?? DEFAULT_XAI_VIDEO_MODEL,
        metadata: {
          requestId,
          status: completed.status,
          videoUrl,
          mode,
        },
      };
    },
  };
}
