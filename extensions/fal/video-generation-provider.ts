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
const DEFAULT_FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/minimax/video-01-live";
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;

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

type FalQueueResponse = {
  status?: string;
  request_id?: string;
  response_url?: string;
  status_url?: string;
  cancel_url?: string;
  detail?: string;
  response?: FalVideoResponse;
  prompt?: string;
  error?: {
    message?: string;
  };
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
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
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

function resolveFalQueueBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "fal.run") {
      url.hostname = "queue.fal.run";
      return url.toString().replace(/\/$/, "");
    }
    return baseUrl.replace(/\/$/, "");
  } catch {
    return DEFAULT_FAL_QUEUE_BASE_URL;
  }
}

function isFalMiniMaxLiveModel(model: string): boolean {
  return model.trim().toLowerCase() === DEFAULT_FAL_VIDEO_MODEL;
}

function buildFalVideoRequestBody(params: {
  req: VideoGenerationRequest;
  model: string;
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    prompt: params.req.prompt,
  };
  const input = params.req.inputImages?.[0];
  if (input) {
    requestBody.image_url = input.url?.trim()
      ? input.url.trim()
      : input.buffer
        ? toDataUrl(input.buffer, input.mimeType?.trim() || "image/png")
        : undefined;
  }
  // MiniMax Live on fal currently documents prompt + optional image_url only.
  // Keep the default model conservative so queue requests do not hang behind
  // unsupported knobs such as duration/resolution/aspect-ratio overrides.
  if (isFalMiniMaxLiveModel(params.model)) {
    return requestBody;
  }
  if (params.req.aspectRatio?.trim()) {
    requestBody.aspect_ratio = params.req.aspectRatio.trim();
  }
  if (params.req.size?.trim()) {
    requestBody.size = params.req.size.trim();
  }
  if (params.req.resolution) {
    requestBody.resolution = params.req.resolution;
  }
  if (
    typeof params.req.durationSeconds === "number" &&
    Number.isFinite(params.req.durationSeconds)
  ) {
    requestBody.duration = Math.max(1, Math.round(params.req.durationSeconds));
  }
  return requestBody;
}

async function fetchFalJson(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
  auditContext: string;
  errorContext: string;
}): Promise<unknown> {
  const { response, release } = await falFetchGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: params.auditContext,
  });
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return await response.json();
  } finally {
    await release();
  }
}

async function waitForFalQueueResult(params: {
  statusUrl: string;
  responseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
}): Promise<FalQueueResponse> {
  const deadline = Date.now() + params.timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const payload = (await fetchFalJson({
      url: params.statusUrl,
      init: {
        method: "GET",
        headers: params.headers,
      },
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      policy: params.policy,
      dispatcherPolicy: params.dispatcherPolicy,
      auditContext: "fal-video-status",
      errorContext: "fal video status request failed",
    })) as FalQueueResponse;
    const status = payload.status?.trim().toUpperCase();
    if (status) {
      lastStatus = status;
    }
    if (status === "COMPLETED") {
      return (await fetchFalJson({
        url: params.responseUrl,
        init: {
          method: "GET",
          headers: params.headers,
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        policy: params.policy,
        dispatcherPolicy: params.dispatcherPolicy,
        auditContext: "fal-video-result",
        errorContext: "fal video result request failed",
      })) as FalQueueResponse;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      throw new Error(
        payload.detail?.trim() ||
          payload.error?.message?.trim() ||
          `fal video generation ${status.toLowerCase()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`fal video generation did not finish in time (last status: ${lastStatus})`);
}

function extractFalVideoPayload(payload: FalQueueResponse): FalVideoResponse {
  if (payload.response && typeof payload.response === "object") {
    return payload.response;
  }
  return payload as FalVideoResponse;
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
      generate: {
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("fal video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("fal video generation supports at most one image reference.");
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
      const model = req.model?.trim() || DEFAULT_FAL_VIDEO_MODEL;
      const requestBody = buildFalVideoRequestBody({ req, model });
      const policy = buildPolicy(allowPrivateNetwork);
      const queueBaseUrl = resolveFalQueueBaseUrl(baseUrl);
      const submitted = (await fetchFalJson({
        url: `${queueBaseUrl}/${model}`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
        auditContext: "fal-video-submit",
        errorContext: "fal video generation failed",
      })) as FalQueueResponse;
      const statusUrl = submitted.status_url?.trim();
      const responseUrl = submitted.response_url?.trim();
      if (!statusUrl || !responseUrl) {
        throw new Error("fal video generation response missing queue URLs");
      }
      const payload = await waitForFalQueueResult({
        statusUrl,
        responseUrl,
        headers,
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
      });
      const videoPayload = extractFalVideoPayload(payload);
      const entry = extractFalVideoEntry(videoPayload);
      const url = entry?.url?.trim();
      if (!url) {
        throw new Error("fal video generation response missing output URL");
      }
      const video = await downloadFalVideo(url, policy);
      return {
        videos: [video],
        model,
        metadata: {
          ...(submitted.request_id?.trim() ? { requestId: submitted.request_id.trim() } : {}),
          ...(videoPayload.prompt ? { prompt: videoPayload.prompt } : {}),
        },
      };
    },
  };
}
