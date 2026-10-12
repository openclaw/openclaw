import { toImageDataUrl } from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperation,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_XAI_VIDEO_BASE_URL,
  DEFAULT_XAI_VIDEO_MODEL,
  XAI_VIDEO_ASPECT_RATIOS,
  XAI_VIDEO_DEFAULT_TIMEOUT_MS,
  createXaiVideoGenerationProviderMetadata,
  isXaiVideo15Model,
} from "./capability-provider-metadata.js";
import { downloadXaiVideo, fetchXaiVideoResponse } from "./video-generation-transport.js";

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

async function readXaiVideoJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await readProviderJsonResponse<unknown>(response, "xAI video generation response");
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": malformed JSON response")) {
      throw new Error(XAI_VIDEO_MALFORMED_RESPONSE, { cause: error });
    }
    throw error;
  }
  if (!isRecord(payload)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return payload;
}

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

function readXaiStatusResponse(payload: Record<string, unknown>): XaiVideoStatusResponse {
  const video = payload.video;
  if (video !== undefined && video !== null && !isRecord(video)) {
    throw new Error(XAI_VIDEO_MALFORMED_RESPONSE);
  }
  return {
    status: normalizeOptionalString(payload.status) ?? "",
    videoUrl: isRecord(video) ? normalizeOptionalString(video.url) : undefined,
    errorMessage: xaiErrorMessage(payload),
  };
}

function resolveImageUrl(input: VideoGenerationSourceAsset): string {
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("xAI image-to-video input is missing image data.");
  }
  return toImageDataUrl({ ...input, buffer: input.buffer, defaultMimeType: "image/png" });
}

function isReferenceImage(input: VideoGenerationSourceAsset): boolean {
  return normalizeOptionalString(input.role)?.toLowerCase() === "reference_image";
}

function isFirstFrameImage(input: VideoGenerationSourceAsset): boolean {
  const role = normalizeOptionalString(input.role)?.toLowerCase();
  return role === undefined || role === "first_frame";
}

function validateXaiVideo15Request(req: VideoGenerationRequest): void {
  if (!isXaiVideo15Model(req.model)) {
    return;
  }
  if ((req.inputVideos?.length ?? 0) > 0) {
    throw new Error("xAI grok-imagine-video-1.5 does not support video inputs.");
  }
  const inputImages = req.inputImages ?? [];
  const [inputImage, ...additionalImages] = inputImages;
  if (!inputImage || additionalImages.length > 0) {
    throw new Error("xAI grok-imagine-video-1.5 requires exactly one first-frame image.");
  }
  if (!isFirstFrameImage(inputImage)) {
    throw new Error("xAI grok-imagine-video-1.5 supports only an ordinary or first_frame image.");
  }
}

function resolveInputVideoUrl(input: VideoGenerationSourceAsset | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const url = normalizeOptionalString(input.url);
  if (url) {
    return url;
  }
  if (input.buffer) {
    throw new Error("xAI video editing currently requires a remote mp4 URL input.");
  }
  throw new Error("xAI video editing input is missing video data.");
}

function resolveDurationSeconds(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveAspectRatio(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !XAI_VIDEO_ASPECT_RATIOS.has(trimmed)) {
    return undefined;
  }
  return trimmed;
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
  validateXaiVideo15Request(req);
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
    body.video = { url: resolveInputVideoUrl(req.inputVideos?.[0]) };
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
  const imageUrl = inputImage ? resolveImageUrl(inputImage) : undefined;
  if (hasReferenceImages) {
    body.reference_images = inputImages.map((image) => ({ url: resolveImageUrl(image) }));
  } else if (imageUrl) {
    body.image = { url: imageUrl };
  }
  body.duration =
    resolveDurationSeconds(req.durationSeconds, 1, hasReferenceImages ? 10 : 15) ??
    XAI_VIDEO_DEFAULT_DURATION_SECONDS;
  const aspectRatio = resolveAspectRatio(req.aspectRatio);
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
    ...createXaiVideoGenerationProviderMetadata(),
    async generateVideo(req) {
      // Validate provider/model mode constraints before auth or HTTP setup so
      // unsupported 1.5 requests cannot be submitted and billed accidentally.
      const { body, endpoint, mode } = prepareCreateRequest(req);
      const auth = await resolveApiKeyForProvider({
        provider: "xai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("xAI API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "xAI video generation",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl:
            normalizeOptionalString(req.cfg?.models?.providers?.xai?.baseUrl) ??
            DEFAULT_XAI_VIDEO_BASE_URL,
          defaultBaseUrl: DEFAULT_XAI_VIDEO_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.xai?.request),
          provider: "xai",
          capability: "video",
          transport: "http",
        });
      // Per-submit idempotency key prevents accidental double-charging if
      // the request is replayed. Polls intentionally reuse `headers` without it.
      const submitHeaders = new Headers(headers);
      submitHeaders.set("x-idempotency-key", crypto.randomUUID());
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${endpoint}`,
        headers: submitHeaders,
        body,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "xAI video generation failed");
        const submitted = await readXaiVideoJson(response);
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
              defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
              allowPrivateNetwork,
              dispatcherPolicy,
              fetchFn,
            });
            try {
              return readXaiStatusResponse(await readXaiVideoJson(pollResponse));
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
        const video = await downloadXaiVideo({
          url: videoUrl,
          timeoutMs: createProviderOperationTimeoutResolver({
            deadline,
            defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
          }),
          defaultTimeoutMs: XAI_VIDEO_DEFAULT_TIMEOUT_MS,
          allowPrivateNetwork,
          dispatcherPolicy,
          fetchFn,
          maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
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
      } finally {
        await release();
      }
    },
  };
}
