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
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_QWEN_VIDEO_MODEL = "wan2.6-t2v";

function resolveQwenVideoBaseUrl(req: VideoGenerationRequest): string {
  const direct = req.cfg?.models?.providers?.qwen?.baseUrl?.trim();
  if (!direct) {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
  try {
    return new URL(direct).toString();
  } catch {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (
      url.hostname === "coding-intl.dashscope.aliyuncs.com" ||
      url.hostname === "coding.dashscope.aliyuncs.com" ||
      url.hostname === "dashscope-intl.aliyuncs.com" ||
      url.hostname === "dashscope.aliyuncs.com"
    ) {
      return url.origin;
    }
  } catch {
    // Fall through to legacy prefix handling for non-URL strings.
  }
  if (baseUrl.startsWith(QWEN_STANDARD_CN_BASE_URL)) {
    return "https://dashscope.aliyuncs.com";
  }
  if (baseUrl.startsWith(QWEN_STANDARD_GLOBAL_BASE_URL)) {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
  return baseUrl.replace(/\/+$/u, "");
}

export function buildQwenVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "qwen",
    label: "Qwen Cloud",
    defaultModel: DEFAULT_QWEN_VIDEO_MODEL,
    models: ["wan2.6-t2v", "wan2.6-i2v", "wan2.6-r2v", "wan2.6-r2v-flash", "wan2.7-r2v"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "qwen",
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
        provider: "qwen",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Qwen API key missing");
      }

      const requestBaseUrl = resolveQwenVideoBaseUrl(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: requestBaseUrl,
          defaultBaseUrl: DEFAULT_QWEN_VIDEO_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          provider: "qwen",
          capability: "video",
          transport: "http",
        });

      const model = req.model?.trim() || DEFAULT_QWEN_VIDEO_MODEL;
      const { response, release } = await postJsonRequest({
        url: `${resolveDashscopeAigcApiBaseUrl(baseUrl)}/api/v1/services/aigc/video-generation/video-synthesis`,
        headers,
        body: {
          model,
          input: buildDashscopeVideoGenerationInput({
            providerLabel: "Qwen",
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
        await assertOkOrThrowHttpError(response, "Qwen video generation failed");
        const submitted = (await response.json()) as DashscopeVideoGenerationResponse;
        const taskId = submitted.output?.task_id?.trim();
        if (!taskId) {
          throw new Error("Qwen video generation response missing task_id");
        }
        const completed = await pollDashscopeVideoTaskUntilComplete({
          providerLabel: "Qwen",
          taskId,
          headers,
          timeoutMs: req.timeoutMs,
          fetchFn,
          baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
          defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
        });
        const urls = extractDashscopeVideoUrls(completed);
        if (urls.length === 0) {
          throw new Error("Qwen video generation completed without output video URLs");
        }
        const videos = await downloadDashscopeGeneratedVideos({
          providerLabel: "Qwen",
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
