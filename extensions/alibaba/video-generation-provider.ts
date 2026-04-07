import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  downloadDashscopeGeneratedVideos,
  extractDashscopeVideoUrls,
  pollDashscopeVideoTaskUntilComplete,
} from "openclaw/plugin-sdk/video-generation";
import type {
  DashscopeVideoGenerationResponse,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_ALIBABA_VIDEO_MODEL = "wan2.6-t2v";

function resolveAlibabaVideoBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.alibaba?.baseUrl?.trim() || DEFAULT_ALIBABA_VIDEO_BASE_URL;
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
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
          input: buildDashscopeVideoGenerationInput({
            providerLabel: "Alibaba Wan",
            req,
          }),
          parameters: buildDashscopeVideoGenerationParameters(
            {
              ...req,
              durationSeconds: req.durationSeconds ?? DEFAULT_VIDEO_GENERATION_DURATION_SECONDS,
            },
            DEFAULT_VIDEO_RESOLUTION_TO_SIZE,
          ),
        },
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Alibaba Wan video generation failed");
        const submitted = (await response.json()) as DashscopeVideoGenerationResponse;
        const taskId = submitted.output?.task_id?.trim();
        if (!taskId) {
          throw new Error("Alibaba Wan video generation response missing task_id");
        }
        const completed = await pollDashscopeVideoTaskUntilComplete({
          providerLabel: "Alibaba Wan",
          taskId,
          headers,
          timeoutMs: req.timeoutMs,
          fetchFn,
          baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
          defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
        });
        const urls = extractDashscopeVideoUrls(completed);
        if (urls.length === 0) {
          throw new Error("Alibaba Wan video generation completed without output video URLs");
        }
        const videos = await downloadDashscopeGeneratedVideos({
          providerLabel: "Alibaba Wan",
          urls,
          timeoutMs: req.timeoutMs,
          fetchFn,
          defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
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
