import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { DEFAULT_VYDRA_VIDEO_MODEL } from "./defaults.js";
import { runVydraGeneration } from "./shared.js";

const VYDRA_KLING_MODEL = "kling";
const DEFAULT_VYDRA_VIDEO_TIMEOUT_MS = 120_000;

export function buildVydraVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "vydra",
    label: "Vydra",
    defaultModel: DEFAULT_VYDRA_VIDEO_MODEL,
    models: [DEFAULT_VYDRA_VIDEO_MODEL, VYDRA_KLING_MODEL],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: "vydra", ...ctx }),
    capabilities: {
      generate: {
        maxVideos: 1,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Vydra video generation does not support video reference inputs.");
      }

      const model = req.model?.trim() || DEFAULT_VYDRA_VIDEO_MODEL;
      const body: Record<string, unknown> = { prompt: req.prompt };
      if (model === VYDRA_KLING_MODEL) {
        const imageUrl = req.inputImages?.[0]?.url?.trim();
        if (!imageUrl) {
          throw new Error("Vydra kling currently requires a remote image URL reference.");
        }
        // Vydra's kling route has been inconsistent about which field it requires.
        body.image_url = imageUrl;
        body.video_url = imageUrl;
      } else if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error(
          `Vydra ${model} does not support image reference inputs in the Vydra plugin.`,
        );
      }
      const generated = await runVydraGeneration({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        kind: "video",
        model,
        body,
        deadlineTimeoutMs: req.timeoutMs ?? DEFAULT_VYDRA_VIDEO_TIMEOUT_MS,
      });
      return {
        videos: [generated.asset],
        model,
        metadata: {
          jobId: generated.jobId,
          videoUrl: generated.resultUrl,
          status: generated.status,
        },
      };
    },
  };
}
