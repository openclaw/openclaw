import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_VYDRA_BASE_URL,
  DEFAULT_VYDRA_VIDEO_MODEL,
  downloadVydraAsset,
  extractVydraResultUrls,
  resolveVydraBaseUrlFromConfig,
  resolveVydraErrorMessage,
  resolveVydraResponseJobId,
  resolveVydraResponseStatus,
  waitForVydraJob,
} from "./shared.js";

const VYDRA_KLING_MODEL = "kling";

function resolveVydraVideoRequestBody(
  req: Parameters<VideoGenerationProvider["generateVideo"]>[0],
) {
  const model = req.model?.trim() || DEFAULT_VYDRA_VIDEO_MODEL;
  if (model === VYDRA_KLING_MODEL) {
    const input = req.inputImages?.[0];
    const imageUrl = input?.url?.trim();
    if (!imageUrl) {
      throw new Error("Vydra kling currently requires a remote image URL reference.");
    }
    return {
      model,
      body: {
        prompt: req.prompt,
        image_url: imageUrl,
      },
    };
  }
  if ((req.inputImages?.length ?? 0) > 0) {
    throw new Error(
      `Vydra ${model} does not support image reference inputs in the bundled plugin.`,
    );
  }
  return {
    model,
    body: {
      prompt: req.prompt,
    },
  };
}

export function buildVydraVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "vydra",
    label: "Vydra",
    defaultModel: DEFAULT_VYDRA_VIDEO_MODEL,
    models: [DEFAULT_VYDRA_VIDEO_MODEL, VYDRA_KLING_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "vydra",
        agentDir,
      }),
    capabilities: {
      maxVideos: 1,
      maxInputImages: 1,
      maxInputVideos: 0,
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Vydra video generation does not support video reference inputs.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "vydra",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Vydra API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveVydraBaseUrlFromConfig(req.cfg),
          defaultBaseUrl: DEFAULT_VYDRA_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "vydra",
          capability: "video",
          transport: "http",
        });
      const { model, body } = resolveVydraVideoRequestBody(req);
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}`,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra video generation failed");
        const submitted = await response.json();
        const completedPayload =
          resolveVydraResponseStatus(submitted) === "completed" ||
          extractVydraResultUrls(submitted, "video").length > 0
            ? submitted
            : await (() => {
                const jobId = resolveVydraResponseJobId(submitted);
                if (!jobId) {
                  throw new Error(
                    resolveVydraErrorMessage(submitted) ??
                      "Vydra video generation response missing job id",
                  );
                }
                return waitForVydraJob({
                  baseUrl,
                  jobId,
                  headers,
                  timeoutMs: req.timeoutMs,
                  fetchFn,
                  kind: "video",
                });
              })();
        const videoUrl = extractVydraResultUrls(completedPayload, "video")[0];
        if (!videoUrl) {
          throw new Error("Vydra video generation completed without a video URL");
        }
        const video = await downloadVydraAsset({
          url: videoUrl,
          kind: "video",
          timeoutMs: req.timeoutMs,
          fetchFn,
        });
        return {
          videos: [
            {
              buffer: video.buffer,
              mimeType: video.mimeType,
              fileName: video.fileName,
            },
          ],
          model,
          metadata: {
            jobId:
              resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
            videoUrl,
            status: resolveVydraResponseStatus(completedPayload) ?? "completed",
          },
        };
      } finally {
        await release();
      }
    },
  };
}
