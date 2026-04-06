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
} from "openclaw/plugin-sdk/video-generation";
import { TOGETHER_BASE_URL } from "./models.js";

const DEFAULT_TOGETHER_VIDEO_MODEL = "Wan-AI/Wan2.2-T2V-A14B";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;

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
  return req.cfg?.models?.providers?.together?.baseUrl?.trim() || TOGETHER_BASE_URL;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function extractTogetherVideoUrl(payload: TogetherVideoResponse): string | undefined {
  if (Array.isArray(payload.outputs)) {
    for (const entry of payload.outputs) {
      const url = entry.video_url?.trim() || entry.url?.trim();
      if (url) {
        return url;
      }
    }
    return undefined;
  }
  return payload.outputs?.video_url?.trim() || payload.outputs?.url?.trim();
}

async function pollTogetherVideo(params: {
  videoId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<TogetherVideoResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/videos/${params.videoId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Together video status request failed");
    const payload = (await response.json()) as TogetherVideoResponse;
    if (payload.status === "completed") {
      return payload;
    }
    if (payload.status === "failed") {
      throw new Error(payload.error?.message?.trim() || "Together video generation failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Together video generation task ${params.videoId} did not finish in time`);
}

async function downloadTogetherVideo(params: {
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
  await assertOkOrThrowHttpError(response, "Together generated video download failed");
  const mimeType = response.headers.get("content-type")?.trim() || "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

export function buildTogetherVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "together",
    label: "Together",
    defaultModel: DEFAULT_TOGETHER_VIDEO_MODEL,
    models: [
      DEFAULT_TOGETHER_VIDEO_MODEL,
      "Wan-AI/Wan2.2-I2V-A14B",
      "minimax/Hailuo-02",
      "Kwai/Kling-2.1-Master",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "together",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 12,
        supportsSize: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 12,
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
      const auth = await resolveApiKeyForProvider({
        provider: "together",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Together API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveTogetherVideoBaseUrl(req),
          defaultBaseUrl: TOGETHER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "together",
          capability: "video",
          transport: "http",
        });
      const body: Record<string, unknown> = {
        model: req.model?.trim() || DEFAULT_TOGETHER_VIDEO_MODEL,
        prompt: req.prompt,
      };
      if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
        body.seconds = String(Math.max(1, Math.round(req.durationSeconds)));
      }
      if (req.size?.trim()) {
        const match = /^(\d+)x(\d+)$/u.exec(req.size.trim());
        if (match) {
          body.width = Number.parseInt(match[1] ?? "", 10);
          body.height = Number.parseInt(match[2] ?? "", 10);
        }
      }
      if (req.inputImages?.[0]) {
        const input = req.inputImages[0];
        const value = input.url?.trim()
          ? input.url.trim()
          : input.buffer
            ? toDataUrl(input.buffer, input.mimeType?.trim() || "image/png")
            : undefined;
        if (!value) {
          throw new Error("Together reference image is missing image data.");
        }
        body.reference_images = [value];
      }
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      try {
        await assertOkOrThrowHttpError(response, "Together video generation failed");
        const submitted = (await response.json()) as TogetherVideoResponse;
        const videoId = submitted.id?.trim();
        if (!videoId) {
          throw new Error("Together video generation response missing id");
        }
        const completed = await pollTogetherVideo({
          videoId,
          headers,
          timeoutMs: req.timeoutMs,
          baseUrl,
          fetchFn,
        });
        const videoUrl = extractTogetherVideoUrl(completed);
        if (!videoUrl) {
          throw new Error("Together video generation completed without an output URL");
        }
        const video = await downloadTogetherVideo({
          url: videoUrl,
          timeoutMs: req.timeoutMs,
          fetchFn,
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
      } finally {
        await release();
      }
    },
  };
}
