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
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_ALIBABA_VIDEO_MODEL = "wan2.6-t2v";
const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_ATTEMPTS = 120;
const RESOLUTION_TO_SIZE: Record<string, string> = {
  "480P": "832*480",
  "720P": "1280*720",
  "1080P": "1920*1080",
};

type AlibabaVideoGenerationResponse = {
  output?: {
    task_id?: string;
    task_status?: string;
    submit_time?: string;
    results?: Array<{
      video_url?: string;
      orig_prompt?: string;
      actual_prompt?: string;
    }>;
    video_url?: string;
    code?: string;
    message?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
};

function resolveAlibabaVideoBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.alibaba?.baseUrl?.trim() || DEFAULT_ALIBABA_VIDEO_BASE_URL;
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function resolveReferenceUrls(
  inputImages: VideoGenerationSourceAsset[] | undefined,
  inputVideos: VideoGenerationSourceAsset[] | undefined,
): string[] {
  return [...(inputImages ?? []), ...(inputVideos ?? [])]
    .map((asset) => asset.url?.trim())
    .filter((value): value is string => Boolean(value));
}

function assertAlibabaReferenceInputsSupported(
  inputImages: VideoGenerationSourceAsset[] | undefined,
  inputVideos: VideoGenerationSourceAsset[] | undefined,
): void {
  const unsupported = [...(inputImages ?? []), ...(inputVideos ?? [])].some(
    (asset) => !asset.url?.trim() && asset.buffer,
  );
  if (unsupported) {
    throw new Error(
      "Alibaba Wan video generation currently requires remote http(s) URLs for reference images/videos.",
    );
  }
}

function buildAlibabaVideoGenerationInput(req: VideoGenerationRequest): Record<string, unknown> {
  assertAlibabaReferenceInputsSupported(req.inputImages, req.inputVideos);
  const input: Record<string, unknown> = {
    prompt: req.prompt,
  };
  const referenceUrls = resolveReferenceUrls(req.inputImages, req.inputVideos);
  if (
    referenceUrls.length === 1 &&
    (req.inputImages?.length ?? 0) === 1 &&
    !req.inputVideos?.length
  ) {
    input.img_url = referenceUrls[0];
  } else if (referenceUrls.length > 0) {
    input.reference_urls = referenceUrls;
  }
  return input;
}

function buildAlibabaVideoGenerationParameters(
  req: VideoGenerationRequest,
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  const size =
    req.size?.trim() || (req.resolution ? RESOLUTION_TO_SIZE[req.resolution] : undefined);
  if (size) {
    parameters.size = size;
  }
  if (req.aspectRatio?.trim()) {
    parameters.aspect_ratio = req.aspectRatio.trim();
  }
  if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
    parameters.duration = Math.max(1, Math.round(req.durationSeconds));
  }
  if (typeof req.audio === "boolean") {
    parameters.enable_audio = req.audio;
  }
  if (typeof req.watermark === "boolean") {
    parameters.watermark = req.watermark;
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

function extractVideoUrls(payload: AlibabaVideoGenerationResponse): string[] {
  const urls = [
    ...(payload.output?.results?.map((entry) => entry.video_url).filter(Boolean) ?? []),
    payload.output?.video_url,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(urls)];
}

async function pollTaskUntilComplete(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  baseUrl: string;
}): Promise<AlibabaVideoGenerationResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/api/v1/tasks/${params.taskId}`,
      {
        method: "GET",
        headers: params.headers,
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Alibaba Wan video-generation task poll failed");
    const payload = (await response.json()) as AlibabaVideoGenerationResponse;
    const status = payload.output?.task_status?.trim().toUpperCase();
    if (status === "SUCCEEDED") {
      return payload;
    }
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(
        payload.output?.message?.trim() ||
          payload.message?.trim() ||
          `Alibaba Wan video generation task ${params.taskId} ${status?.toLowerCase()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Alibaba Wan video generation task ${params.taskId} did not finish in time`);
}

async function downloadGeneratedVideos(params: {
  urls: string[];
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset[]> {
  const videos: GeneratedVideoAsset[] = [];
  for (const [index, url] of params.urls.entries()) {
    const response = await fetchWithTimeout(
      url,
      { method: "GET" },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "Alibaba Wan generated video download failed");
    const arrayBuffer = await response.arrayBuffer();
    videos.push({
      buffer: Buffer.from(arrayBuffer),
      mimeType: response.headers.get("content-type")?.trim() || "video/mp4",
      fileName: `video-${index + 1}.mp4`,
      metadata: { sourceUrl: url },
    });
  }
  return videos;
}

export function buildAlibabaVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "alibaba",
    label: "Alibaba Model Studio",
    defaultModel: DEFAULT_ALIBABA_VIDEO_MODEL,
    models: ["wan2.6-t2v", "wan2.6-i2v", "wan2.6-r2v", "wan2.6-r2v-flash", "wan2.7-r2v"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "alibaba",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 10,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        maxDurationSeconds: 10,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 4,
        maxDurationSeconds: 10,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      const fetchFn = fetch;
      const auth = await resolveApiKeyForProvider({
        provider: "alibaba",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Alibaba Model Studio API key missing");
      }

      const requestBaseUrl = resolveAlibabaVideoBaseUrl(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: requestBaseUrl,
          defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          provider: "alibaba",
          capability: "video",
          transport: "http",
        });

      const model = req.model?.trim() || DEFAULT_ALIBABA_VIDEO_MODEL;
      const { response, release } = await postJsonRequest({
        url: `${resolveDashscopeAigcApiBaseUrl(baseUrl)}/api/v1/services/aigc/video-generation/video-synthesis`,
        headers,
        body: {
          model,
          input: buildAlibabaVideoGenerationInput(req),
          parameters: buildAlibabaVideoGenerationParameters({
            ...req,
            durationSeconds: req.durationSeconds ?? DEFAULT_DURATION_SECONDS,
          }),
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Alibaba Wan video generation failed");
        const submitted = (await response.json()) as AlibabaVideoGenerationResponse;
        const taskId = submitted.output?.task_id?.trim();
        if (!taskId) {
          throw new Error("Alibaba Wan video generation response missing task_id");
        }
        const completed = await pollTaskUntilComplete({
          taskId,
          headers,
          timeoutMs: req.timeoutMs,
          fetchFn,
          baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
        });
        const urls = extractVideoUrls(completed);
        if (urls.length === 0) {
          throw new Error("Alibaba Wan video generation completed without output video URLs");
        }
        const videos = await downloadGeneratedVideos({
          urls,
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          videos,
          model,
          metadata: {
            requestId: submitted.request_id,
            taskId,
            taskStatus: completed.output?.task_status,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
