import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  type SsrFPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/minimax/video-01-live";
const DEFAULT_TIMEOUT_MS = 180_000;

type FalVideoResponse = {
  video?: {
    url?: string;
    content_type?: string;
  };
  videos?: Array<{
    url?: string;
    content_type?: string;
  }>;
  prompt?: string;
};

let falFetchGuard = fetchWithSsrFGuard;

export function _setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  falFetchGuard = impl ?? fetchWithSsrFGuard;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildPolicy(allowPrivateNetwork: boolean): SsrFPolicy | undefined {
  return allowPrivateNetwork ? ssrfPolicyFromDangerouslyAllowPrivateNetwork(true) : undefined;
}

function extractFalVideoEntry(payload: FalVideoResponse) {
  if (payload.video?.url?.trim()) {
    return payload.video;
  }
  return payload.videos?.find((entry) => entry.url?.trim());
}

async function downloadFalVideo(
  url: string,
  policy: SsrFPolicy | undefined,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await falFetchGuard({
    url,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    policy,
    auditContext: "fal-video-download",
  });
  try {
    await assertOkOrThrowHttpError(response, "fal generated video download failed");
    const mimeType = response.headers.get("content-type")?.trim() || "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    };
  } finally {
    await release();
  }
}

export function buildFalVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_VIDEO_MODEL,
    models: [
      DEFAULT_FAL_VIDEO_MODEL,
      "fal-ai/kling-video/v2.1/master/text-to-video",
      "fal-ai/wan/v2.2-a14b/text-to-video",
      "fal-ai/wan/v2.2-a14b/image-to-video",
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "fal",
        agentDir,
      }),
    capabilities: {
      maxVideos: 1,
      maxInputImages: 1,
      maxInputVideos: 0,
      supportsAspectRatio: true,
      supportsResolution: true,
      supportsSize: true,
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("fal video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "fal",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("fal API key missing");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.fal?.baseUrl?.trim(),
          defaultBaseUrl: DEFAULT_FAL_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Key ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "fal",
          capability: "video",
          transport: "http",
        });
      const requestBody: Record<string, unknown> = {
        prompt: req.prompt,
      };
      if (req.aspectRatio?.trim()) {
        requestBody.aspect_ratio = req.aspectRatio.trim();
      }
      if (req.size?.trim()) {
        requestBody.size = req.size.trim();
      }
      if (req.resolution) {
        requestBody.resolution = req.resolution;
      }
      if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
        requestBody.duration = Math.max(1, Math.round(req.durationSeconds));
      }
      if (req.inputImages?.[0]) {
        const input = req.inputImages[0];
        requestBody.image_url = input.url?.trim()
          ? input.url.trim()
          : input.buffer
            ? toDataUrl(input.buffer, input.mimeType?.trim() || "image/png")
            : undefined;
      }

      const { response, release } = await falFetchGuard({
        url: `${baseUrl}/${req.model?.trim() || DEFAULT_FAL_VIDEO_MODEL}`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        policy: buildPolicy(allowPrivateNetwork),
        dispatcherPolicy,
        auditContext: "fal-video-generate",
      });
      try {
        await assertOkOrThrowHttpError(response, "fal video generation failed");
        const payload = (await response.json()) as FalVideoResponse;
        const entry = extractFalVideoEntry(payload);
        const url = entry?.url?.trim();
        if (!url) {
          throw new Error("fal video generation response missing output URL");
        }
        const video = await downloadFalVideo(url, buildPolicy(allowPrivateNetwork));
        return {
          videos: [video],
          model: req.model?.trim() || DEFAULT_FAL_VIDEO_MODEL,
          metadata: payload.prompt ? { prompt: payload.prompt } : undefined,
        };
      } finally {
        await release();
      }
    },
  };
}
