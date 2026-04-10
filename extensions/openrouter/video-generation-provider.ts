import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResolution,
} from "openclaw/plugin-sdk/video-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";
const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/veo-3.1";
const OPENROUTER_VIDEO_MODELS = ["google/veo-3.1"] as const;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_TIMEOUT_MS = 120_000;
const OPENROUTER_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const OPENROUTER_VIDEO_RESOLUTIONS: readonly VideoGenerationResolution[] = [
  "480P",
  "720P",
  "1080P",
];

type OpenRouterVideoStatus = "pending" | "in_progress" | "completed" | "failed";

type OpenRouterVideoSubmitResponse = {
  id?: string;
  polling_url?: string;
  status?: OpenRouterVideoStatus;
};

type OpenRouterVideoPollResponse = {
  id?: string;
  generation_id?: string;
  polling_url?: string;
  status?: OpenRouterVideoStatus;
  unsigned_urls?: string[];
  usage?: {
    cost?: number;
    is_byok?: boolean;
  };
};

function toBase64DataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildInputReferences(req: VideoGenerationRequest) {
  const images = req.inputImages ?? [];
  if (images.length === 0) {
    return undefined;
  }
  if (images.length > 1) {
    throw new Error("OpenRouter video generation supports at most one reference image.");
  }
  const [image] = images;
  if (!image?.buffer) {
    throw new Error("OpenRouter video generation requires a loaded reference image.");
  }
  const mimeType = normalizeOptionalString(image.mimeType) || "image/png";
  return [
    {
      type: "image_url",
      image_url: toBase64DataUrl(image.buffer, mimeType),
    },
  ];
}

async function pollOpenRouterVideo(params: {
  pollingUrl: string;
  headers: Headers;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<OpenRouterVideoPollResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      params.pollingUrl,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "OpenRouter video status request failed");
    const payload = (await response.json()) as OpenRouterVideoPollResponse;

    if (payload.status === "completed") {
      return payload;
    }
    if (payload.status === "failed") {
      throw new Error("OpenRouter video generation failed");
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("OpenRouter video generation did not finish in time");
}

async function downloadOpenRouterVideo(params: {
  videoId: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs: number;
  fetchFn: typeof fetch;
  unsignedUrl?: string;
}): Promise<GeneratedVideoAsset> {
  const isUnsigned = Boolean(params.unsignedUrl);
  const url =
    params.unsignedUrl ?? `${params.baseUrl}/videos/${params.videoId}/content?index=0`;
  // Unsigned URLs may point to third-party CDNs; omit auth headers to avoid leaking the API key.
  const downloadHeaders = isUnsigned ? new Headers() : params.headers;
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: downloadHeaders,
    },
    params.timeoutMs,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "OpenRouter video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

export function buildOpenrouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_VIDEO_MODEL,
    models: [...OPENROUTER_VIDEO_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: false,
        aspectRatios: [...OPENROUTER_VIDEO_ASPECT_RATIOS],
        resolutions: [...OPENROUTER_VIDEO_RESOLUTIONS],
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: false,
        aspectRatios: [...OPENROUTER_VIDEO_ASPECT_RATIOS],
        resolutions: [...OPENROUTER_VIDEO_RESOLUTIONS],
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveConfiguredBaseUrl(req.cfg),
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openrouter",
          capability: "video",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_VIDEO_MODEL;
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      const resolution = normalizeOptionalString(req.resolution);
      const inputReferences = buildInputReferences(req);

      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers: jsonHeaders,
        body: {
          model,
          prompt: req.prompt,
          ...(req.durationSeconds != null ? { duration: req.durationSeconds } : {}),
          ...(resolution ? { resolution: resolution.toLowerCase() } : {}),
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(req.audio != null ? { generate_audio: req.audio } : {}),
          ...(inputReferences ? { input_references: inputReferences } : {}),
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter video generation failed");
        const submitted = (await response.json()) as OpenRouterVideoSubmitResponse;
        const videoId = normalizeOptionalString(submitted.id);
        if (!videoId) {
          throw new Error("OpenRouter video generation response missing video id");
        }

        const pollingUrl =
          normalizeOptionalString(submitted.polling_url) ?? `${baseUrl}/videos/${videoId}`;
        const completed = await pollOpenRouterVideo({
          pollingUrl,
          headers,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchFn,
        });

        const video = await downloadOpenRouterVideo({
          videoId,
          baseUrl,
          headers,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchFn,
          unsignedUrl: completed.unsigned_urls?.[0],
        });

        return {
          videos: [video],
          model,
          metadata: {
            videoId,
            generationId: completed.generation_id,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
