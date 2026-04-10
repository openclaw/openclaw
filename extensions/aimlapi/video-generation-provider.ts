import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

const AIMLAPI_VIDEO_API_BASE_URL = "https://api.aimlapi.com";
const AIMLAPI_VIDEO_GENERATIONS_PATH = "/v2/video/generations";
const AIMLAPI_DEFAULT_VIDEO_MODEL = "google/veo-3.1-t2v-fast";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 100;
const AIMLAPI_SUPPORTED_VIDEO_DURATIONS = [4, 6, 8] as const;
const AIMLAPI_SUPPORTED_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
const AIMLAPI_SUPPORTED_VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;

type AimlapiVideoGenerationStatus =
  | "waiting"
  | "active"
  | "queued"
  | "generating"
  | "completed"
  | "error";

type AimlapiVideoGenerationResponse = {
  id?: string;
  status?: string;
  video?: {
    url?: string;
  } | null;
  error?:
    | {
        name?: string;
        message?: string;
      }
    | string
    | null;
  meta?: {
    usage?: {
      credits_used?: number;
    };
  } | null;
};

function normalizeAimlapiVideoPublicModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : AIMLAPI_DEFAULT_VIDEO_MODEL;
}

function resolveAimlapiVideoApiModel(model: string | undefined): string {
  return normalizeAimlapiVideoPublicModel(model);
}

function resolveAimlapiVideoStatus(
  payload: AimlapiVideoGenerationResponse,
): AimlapiVideoGenerationStatus | undefined {
  const status = payload.status?.trim().toLowerCase();
  if (
    status === "waiting" ||
    status === "active" ||
    status === "queued" ||
    status === "generating" ||
    status === "completed" ||
    status === "error"
  ) {
    return status;
  }
  return undefined;
}

function extractAimlapiVideoError(payload: AimlapiVideoGenerationResponse): string | undefined {
  const error = payload.error;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || undefined;
  }
  const message = error?.message?.trim();
  if (message) {
    return message;
  }
  const name = error?.name?.trim();
  return name || undefined;
}

function requireNoReferenceInputs(req: VideoGenerationRequest): void {
  if ((req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0) {
    throw new Error("AIMLAPI video generation currently supports text-to-video only.");
  }
}

async function pollAimlapiVideoUntilComplete(params: {
  generationId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  baseUrl: string;
  initial?: AimlapiVideoGenerationResponse;
}): Promise<AimlapiVideoGenerationResponse> {
  const initialStatus = params.initial ? resolveAimlapiVideoStatus(params.initial) : undefined;
  if (initialStatus === "completed") {
    return params.initial as AimlapiVideoGenerationResponse;
  }
  if (initialStatus === "error") {
    throw new Error(
      extractAimlapiVideoError(params.initial as AimlapiVideoGenerationResponse) ||
        `AIMLAPI video generation task ${params.generationId} failed`,
    );
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}${AIMLAPI_VIDEO_GENERATIONS_PATH}?generation_id=${encodeURIComponent(params.generationId)}`,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "AIMLAPI video-generation task poll failed");
    const payload = (await response.json()) as AimlapiVideoGenerationResponse;
    const status = resolveAimlapiVideoStatus(payload);
    if (status === "completed") {
      return payload;
    }
    if (status === "error") {
      throw new Error(
        extractAimlapiVideoError(payload) ||
          `AIMLAPI video generation task ${params.generationId} failed`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`AIMLAPI video generation task ${params.generationId} did not finish in time`);
}

async function downloadGeneratedVideo(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchWithTimeout(
    params.url,
    {
      method: "GET",
    },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "AIMLAPI generated video download failed");
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get("content-type")?.trim() || "video/mp4",
    fileName: "video-1.mp4",
    metadata: { sourceUrl: params.url },
  };
}

export function buildAimlapiVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "aimlapi",
    label: "AI/ML API",
    defaultModel: AIMLAPI_DEFAULT_VIDEO_MODEL,
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "aimlapi",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxInputImages: 0,
        maxInputVideos: 0,
        maxDurationSeconds:
          AIMLAPI_SUPPORTED_VIDEO_DURATIONS[AIMLAPI_SUPPORTED_VIDEO_DURATIONS.length - 1],
        supportedDurationSeconds: AIMLAPI_SUPPORTED_VIDEO_DURATIONS,
        aspectRatios: AIMLAPI_SUPPORTED_VIDEO_ASPECT_RATIOS,
        resolutions: AIMLAPI_SUPPORTED_VIDEO_RESOLUTIONS,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      requireNoReferenceInputs(req);
      const fetchFn = fetch;
      const auth = await resolveApiKeyForProvider({
        provider: "aimlapi",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("AI/ML API key missing");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          defaultBaseUrl: AIMLAPI_VIDEO_API_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "aimlapi",
          capability: "video",
          transport: "http",
        });

      const publicModel = normalizeAimlapiVideoPublicModel(req.model);
      const apiModel = resolveAimlapiVideoApiModel(req.model);
      const resolution =
        req.resolution === "720P"
          ? "720p"
          : req.resolution === "1080P"
            ? "1080p"
            : undefined;
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}${AIMLAPI_VIDEO_GENERATIONS_PATH}`,
        headers,
        body: {
          model: apiModel,
          prompt: req.prompt,
          ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
          ...(typeof req.durationSeconds === "number" ? { duration: req.durationSeconds } : {}),
          ...(resolution ? { resolution } : {}),
          ...(typeof req.audio === "boolean" ? { generate_audio: req.audio } : {}),
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "AIMLAPI video generation failed");
        const submitted = (await response.json()) as AimlapiVideoGenerationResponse;
        const generationId = submitted.id?.trim();
        if (!generationId) {
          throw new Error("AIMLAPI video generation response missing generation id");
        }
        const completed = await pollAimlapiVideoUntilComplete({
          generationId,
          headers,
          timeoutMs: req.timeoutMs,
          fetchFn,
          baseUrl,
          initial: submitted,
        });
        const videoUrl = completed.video?.url?.trim();
        if (!videoUrl) {
          throw new Error("AIMLAPI video generation completed without a video URL");
        }
        const video = await downloadGeneratedVideo({
          url: videoUrl,
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          videos: [video],
          model: publicModel,
          metadata: {
            generationId,
            taskStatus: completed.status,
            creditsUsed: completed.meta?.usage?.credits_used,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
