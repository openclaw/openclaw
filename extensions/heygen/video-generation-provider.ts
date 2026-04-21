// HeyGen video generation provider.
// Pattern mirrored from extensions/runway/video-generation-provider.ts.
// Upstream API: https://docs.heygen.com (v3 Video Agent).
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_HEYGEN_BASE_URL = "https://api.heygen.com";
const DEFAULT_HEYGEN_MODEL = "avatar_iv";
const HEYGEN_USER_AGENT = "OpenClaw-HeyGen-Provider/0.1.0";
const HEYGEN_SOURCE_HEADER = "openclaw-plugin";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const MAX_DURATION_SECONDS = 120;

const HEYGEN_MODELS = ["avatar_iv", "video_agent"] as const;
const HEYGEN_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

type HeygenOrientation = "landscape" | "portrait" | "square";

// Poll statuses reported by GET /v3/videos/{id}. The create response may also
// return "generating"; we treat it as an in-progress state.
type HeygenVideoStatus = "pending" | "processing" | "generating" | "completed" | "failed";

type HeygenCreateResponse = {
  data?: {
    session_id?: string;
    video_id?: string | null;
    status?: HeygenVideoStatus;
    created_at?: number;
  };
  error?: { message?: string; code?: string } | string | null;
  message?: string;
};

type HeygenVideoDetailResponse = {
  data?: {
    id?: string;
    status?: HeygenVideoStatus;
    video_url?: string | null;
    thumbnail_url?: string | null;
    duration?: number | null;
    created_at?: number | null;
    completed_at?: number | null;
    failure_code?: string | null;
    failure_message?: string | null;
  };
  error?: { message?: string; code?: string } | string | null;
  message?: string;
};

type HeygenFileInput =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string };

type HeygenSourceAsset = Pick<VideoGenerationSourceAsset, "buffer" | "mimeType" | "url">;

function resolveHeygenBaseUrl(req: VideoGenerationRequest): string {
  // Extensions may override via cfg.models.providers.heygen.baseUrl when the
  // provider config is declared. Fall back to the public API otherwise.
  // pattern from extensions/runway/video-generation-provider.ts
  const providers = req.cfg?.models?.providers as
    | Record<string, { baseUrl?: unknown } | undefined>
    | undefined;
  return normalizeOptionalString(providers?.heygen?.baseUrl) ?? DEFAULT_HEYGEN_BASE_URL;
}

function resolveProviderOptions(req: VideoGenerationRequest): Record<string, unknown> {
  return req.providerOptions ?? {};
}

function resolveOrientation(
  req: VideoGenerationRequest,
  opts: Record<string, unknown>,
): HeygenOrientation | undefined {
  const explicit = normalizeLowercaseStringOrEmpty(opts.orientation);
  if (explicit === "landscape" || explicit === "portrait" || explicit === "square") {
    return explicit;
  }
  const aspect = normalizeOptionalString(req.aspectRatio);
  switch (aspect) {
    case "16:9":
      return "landscape";
    case "9:16":
      return "portrait";
    case "1:1":
      return "square";
    default:
      return undefined;
  }
}

function resolveAspectRatio(req: VideoGenerationRequest): string | undefined {
  const aspect = normalizeOptionalString(req.aspectRatio);
  if (!aspect) {
    return undefined;
  }
  if (!HEYGEN_ASPECT_RATIOS.includes(aspect as (typeof HEYGEN_ASPECT_RATIOS)[number])) {
    throw new Error(
      `HeyGen video generation does not support aspect ratio ${aspect}. Use one of: ${HEYGEN_ASPECT_RATIOS.join(", ")}.`,
    );
  }
  return aspect;
}

function toBase64FileInput(asset: HeygenSourceAsset): HeygenFileInput | undefined {
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return { type: "url", url };
  }
  if (!asset.buffer) {
    return undefined;
  }
  const mediaType = normalizeOptionalString(asset.mimeType) ?? "image/png";
  return {
    type: "base64",
    media_type: mediaType,
    data: asset.buffer.toString("base64"),
  };
}

function buildFileInputs(req: VideoGenerationRequest): HeygenFileInput[] {
  const files: HeygenFileInput[] = [];
  for (const image of req.inputImages ?? []) {
    const entry = toBase64FileInput(image);
    if (entry) {
      files.push(entry);
    }
  }
  return files;
}

function buildCreateBody(req: VideoGenerationRequest): Record<string, unknown> {
  const opts = resolveProviderOptions(req);
  const body: Record<string, unknown> = {
    prompt: req.prompt,
  };

  const avatarId = normalizeOptionalString(opts.avatar_id);
  if (avatarId) {
    body.avatar_id = avatarId;
  }
  const voiceId = normalizeOptionalString(opts.voice_id);
  if (voiceId) {
    body.voice_id = voiceId;
  }
  const styleId = normalizeOptionalString(opts.style_id);
  if (styleId) {
    body.style_id = styleId;
  }

  const orientation = resolveOrientation(req, opts);
  if (orientation) {
    body.orientation = orientation;
  }

  const aspectRatio = resolveAspectRatio(req);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }

  const callbackUrl = normalizeOptionalString(opts.callback_url);
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }
  const callbackId = normalizeOptionalString(opts.callback_id);
  if (callbackId) {
    body.callback_id = callbackId;
  }

  const files = buildFileInputs(req);
  if (files.length > 0) {
    body.files = files;
  }

  return body;
}

function extractErrorMessage(payload: {
  error?: { message?: string; code?: string } | string | null;
  message?: string;
}): string | undefined {
  if (typeof payload.error === "string") {
    return normalizeOptionalString(payload.error) ?? undefined;
  }
  if (payload.error && typeof payload.error === "object") {
    return normalizeOptionalString(payload.error.message) ?? undefined;
  }
  return normalizeOptionalString(payload.message) ?? undefined;
}

async function pollHeygenVideo(params: {
  videoId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<HeygenVideoDetailResponse["data"]> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `HeyGen video generation ${params.videoId}`,
  });
  // pattern from extensions/runway/video-generation-provider.ts
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/v3/videos/${params.videoId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "HeyGen video status request failed");
    const payload = (await response.json()) as HeygenVideoDetailResponse;
    const detail = payload.data;
    switch (detail?.status) {
      case "completed":
        return detail;
      case "failed": {
        const message =
          normalizeOptionalString(detail.failure_message) ||
          normalizeOptionalString(detail.failure_code) ||
          extractErrorMessage(payload) ||
          "HeyGen video generation failed";
        throw new Error(message);
      }
      case "pending":
      case "processing":
      case "generating":
      default:
        await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
        break;
    }
  }
  throw new Error(`HeyGen video generation ${params.videoId} did not finish in allotted time`);
}

async function downloadHeygenVideo(params: {
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
  await assertOkOrThrowHttpError(response, "HeyGen generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  const fileExt = mimeType.includes("webm") ? "webm" : "mp4";
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${fileExt}`,
    metadata: { sourceUrl: params.url },
  };
}

function translateCreateError(status: number, bodyText: string): Error {
  const lowerBody = bodyText.toLowerCase();
  if (status === 401) {
    return new Error("HeyGen API key missing or invalid");
  }
  if (status === 402) {
    return new Error("HeyGen credit limit reached");
  }
  if (status === 404) {
    if (lowerBody.includes("avatar")) {
      return new Error("HeyGen avatar not found. Check the provided avatar_id.");
    }
    if (lowerBody.includes("voice")) {
      return new Error("HeyGen voice not found. Check the provided voice_id.");
    }
    return new Error("HeyGen resource not found");
  }
  return new Error(
    `HeyGen video generation failed with status ${status}: ${bodyText || "(empty response body)"}`,
  );
}

export function buildHeygenVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "heygen",
    label: "HeyGen",
    defaultModel: DEFAULT_HEYGEN_MODEL,
    models: [...HEYGEN_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "heygen",
        agentDir,
      }),
    capabilities: {
      // Shared across modes. Pattern from extensions/byteplus/video-generation-provider.ts.
      providerOptions: {
        avatar_id: "string",
        voice_id: "string",
        style_id: "string",
        orientation: "string",
        callback_url: "string",
        callback_id: "string",
      },
      generate: {
        maxVideos: 1,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: HEYGEN_ASPECT_RATIOS,
        supportsAspectRatio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: HEYGEN_ASPECT_RATIOS,
        supportsAspectRatio: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      const auth = await resolveApiKeyForProvider({
        provider: "heygen",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("HeyGen API key missing");
      }

      // Reject video inputs up front. HeyGen v3 file inputs accept images,
      // audio, and PDFs as scene context, but the video_generate contract
      // treats videoToVideo as a distinct, disabled mode for this provider.
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("HeyGen video generation does not support video inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("HeyGen video generation supports at most one input image.");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "HeyGen video generation",
      });
      const requestBody = buildCreateBody(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveHeygenBaseUrl(req),
          defaultBaseUrl: DEFAULT_HEYGEN_BASE_URL,
          defaultHeaders: {
            "X-Api-Key": auth.apiKey,
            "Content-Type": "application/json",
            "User-Agent": HEYGEN_USER_AGENT,
            "X-HeyGen-Source": HEYGEN_SOURCE_HEADER,
          },
          provider: "heygen",
          capability: "video",
          transport: "http",
        });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/v3/video-agents`,
        headers,
        body: requestBody,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        if (!response.ok) {
          // Read text so we can preserve vendor-specific messaging for 401/402/404.
          const bodyText = await response.text().catch(() => "");
          throw translateCreateError(response.status, bodyText);
        }
        const submitted = (await response.json()) as HeygenCreateResponse;
        const submittedData = submitted.data;
        const videoId = normalizeOptionalString(submittedData?.video_id);
        const sessionId = normalizeOptionalString(submittedData?.session_id);
        if (!videoId) {
          const explained =
            extractErrorMessage(submitted) ?? "HeyGen video generation response missing video_id";
          throw new Error(explained);
        }

        const completed = await pollHeygenVideo({
          videoId,
          headers,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          baseUrl,
          fetchFn,
        });
        const videoUrl = normalizeOptionalString(completed?.video_url);
        if (!videoUrl) {
          throw new Error("HeyGen video generation completed without a video_url");
        }
        const asset = await downloadHeygenVideo({
          url: videoUrl,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
        });
        return {
          videos: [asset],
          model: normalizeOptionalString(req.model) ?? DEFAULT_HEYGEN_MODEL,
          metadata: {
            videoId,
            sessionId,
            status: completed?.status,
            durationSeconds: completed?.duration ?? undefined,
            thumbnailUrl: normalizeOptionalString(completed?.thumbnail_url) ?? undefined,
            videoUrl,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
