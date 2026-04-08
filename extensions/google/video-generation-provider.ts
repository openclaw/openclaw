import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  postJsonRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiHttpRequestConfig,
} from "./runtime-api.js";

const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 90;
const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS = [4, 6, 8] as const;
const GOOGLE_VIDEO_MIN_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[0];
const GOOGLE_VIDEO_MAX_DURATION_SECONDS =
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.length - 1];

function resolveConfiguredGoogleVideoBaseUrl(req: VideoGenerationRequest): string | undefined {
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
  return configured || undefined;
}

function parseVideoSize(size: string | undefined): { width: number; height: number } | undefined {
  const trimmed = normalizeOptionalString(size);
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
}

function resolveAspectRatio(params: {
  aspectRatio?: string;
  size?: string;
}): "16:9" | "9:16" | undefined {
  const direct = normalizeOptionalString(params.aspectRatio);
  if (direct === "16:9" || direct === "9:16") {
    return direct;
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  return parsedSize.width >= parsedSize.height ? "16:9" : "9:16";
}

function resolveResolution(params: {
  resolution?: string;
  size?: string;
}): "720p" | "1080p" | undefined {
  if (params.resolution === "720P") {
    return "720p";
  }
  if (params.resolution === "1080P") {
    return "1080p";
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  const maxEdge = Math.max(parsedSize.width, parsedSize.height);
  return maxEdge >= 1920 ? "1080p" : maxEdge >= 1280 ? "720p" : undefined;
}

function resolveDurationSeconds(durationSeconds: number | undefined): "4" | "6" | "8" | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.min(
    GOOGLE_VIDEO_MAX_DURATION_SECONDS,
    Math.max(GOOGLE_VIDEO_MIN_DURATION_SECONDS, Math.round(durationSeconds)),
  );
  const nearest = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
  return String(nearest) as "4" | "6" | "8";
}

function resolveInputImage(req: VideoGenerationRequest) {
  const input = req.inputImages?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    inlineData: {
      mimeType: normalizeOptionalString(input.mimeType) || "image/png",
      data: input.buffer.toString("base64"),
    },
  };
}

function resolveInputVideo(req: VideoGenerationRequest) {
  const input = req.inputVideos?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    inlineData: {
      mimeType: normalizeOptionalString(input.mimeType) || "video/mp4",
      data: input.buffer.toString("base64"),
    },
  };
}

type GoogleVeoPredictLongRunningResponse = {
  name?: string;
};

type GoogleVeoOperation = {
  done?: boolean;
  error?: unknown;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: {
          uri?: string;
          mimeType?: string;
          videoBytes?: string;
        };
      }>;
    };
  };
};

function extractGeneratedVideoAsset(params: { operation: GoogleVeoOperation }): {
  uri?: string;
  inline?: GeneratedVideoAsset;
} {
  const sample = params.operation.response?.generateVideoResponse?.generatedSamples?.[0];
  const video = sample?.video;
  if (!video) {
    return {};
  }
  const inlineBytes = normalizeOptionalString(video.videoBytes);
  if (inlineBytes) {
    const mimeType = normalizeOptionalString(video.mimeType) || "video/mp4";
    return {
      inline: {
        buffer: Buffer.from(inlineBytes, "base64"),
        mimeType,
        fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
      },
    };
  }
  return { uri: normalizeOptionalString(video.uri) };
}

async function pollVeoOperation(params: {
  baseUrl: string;
  operationName: string;
  headers: Headers;
  timeoutMs: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: unknown;
}): Promise<GoogleVeoOperation> {
  const operationUrl = `${params.baseUrl}/${params.operationName}`;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const { response: res, release } = await fetchWithTimeoutGuarded(
      operationUrl,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs,
      params.fetchFn,
      {
        ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
        ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy as never } : {}),
      },
    );
    try {
      await assertOkOrThrowHttpError(res, "Google video operation status request failed");
      const payload = (await res.json()) as GoogleVeoOperation;
      if (payload.done) {
        return payload;
      }
    } finally {
      await release();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Google video generation did not finish in time");
}

async function downloadVeoVideo(params: {
  url: string;
  headers: Headers;
  timeoutMs: number;
  fetchFn: typeof fetch;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: unknown;
}): Promise<GeneratedVideoAsset> {
  const { response: res, release } = await fetchWithTimeoutGuarded(
    params.url,
    {
      method: "GET",
      headers: new Headers({
        ...Object.fromEntries(params.headers.entries()),
        Accept: "application/binary",
      }),
    },
    params.timeoutMs,
    params.fetchFn,
    {
      ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy as never } : {}),
    },
  );
  try {
    await assertOkOrThrowHttpError(res, "Google video download failed");
    const mimeType = normalizeOptionalString(res.headers.get("content-type")) ?? "video/mp4";
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    };
  } finally {
    await release();
  }
}

export function buildGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    models: [
      DEFAULT_GOOGLE_VIDEO_MODEL,
      "veo-3.1-generate-preview",
      "veo-3.1-lite-generate-preview",
      "veo-3.0-fast-generate-001",
      "veo-3.0-generate-001",
      "veo-2.0-generate-001",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "google",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
        supportedDurationSeconds: GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
    },
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input image.");
      }
      if ((req.inputVideos?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input video.");
      }
      if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
        throw new Error(
          "Google video generation does not support image and video inputs together.",
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const fetchFn = fetch;
      const model = normalizeGoogleModelId(
        normalizeOptionalString(req.model) || DEFAULT_GOOGLE_VIDEO_MODEL,
      );
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const durationSeconds = resolveDurationSeconds(req.durationSeconds);
      const aspectRatio = resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size });
      const resolution = resolveResolution({ resolution: req.resolution, size: req.size });

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveGoogleGenerativeAiHttpRequestConfig({
          apiKey: auth.apiKey,
          baseUrl: resolveConfiguredGoogleVideoBaseUrl(req),
          capability: "video",
          transport: "http",
        });

      const { response: submitRes, release: submitRelease } = await postJsonRequest({
        url: `${baseUrl}/models/${model}:predictLongRunning`,
        headers,
        body: {
          instances: [
            {
              prompt: req.prompt,
              ...(resolveInputImage(req) ? { image: resolveInputImage(req) } : {}),
              ...(resolveInputVideo(req) ? { video: resolveInputVideo(req) } : {}),
            },
          ],
          parameters: {
            numberOfVideos: 1,
            ...(durationSeconds ? { durationSeconds } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
          },
        },
        timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      let operationName: string | undefined;
      try {
        await assertOkOrThrowHttpError(submitRes, "Google video generation request failed");
        const submitted = (await submitRes.json()) as GoogleVeoPredictLongRunningResponse;
        operationName = normalizeOptionalString(submitted.name);
      } finally {
        await submitRelease();
      }
      if (!operationName) {
        throw new Error("Google video generation response missing operation name");
      }

      const operation = await pollVeoOperation({
        baseUrl,
        operationName,
        headers,
        timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      if (operation.error) {
        throw new Error(JSON.stringify(operation.error));
      }

      const { uri, inline } = extractGeneratedVideoAsset({ operation });
      const video = inline
        ? inline
        : uri
          ? await downloadVeoVideo({
              url: uri,
              headers,
              timeoutMs,
              fetchFn,
              allowPrivateNetwork,
              dispatcherPolicy,
            })
          : null;
      if (!video) {
        throw new Error("Google video generation response missing generated video");
      }
      return {
        videos: [video],
        model,
        metadata: {
          operationName,
        },
      };
    },
  };
}
