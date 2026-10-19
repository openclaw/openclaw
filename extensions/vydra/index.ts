import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_VYDRA_IMAGE_MODEL, DEFAULT_VYDRA_VIDEO_MODEL } from "./defaults.js";
import { applyVydraConfig } from "./onboard.js";
import { runVydraGeneration } from "./shared.js";
import { buildVydraSpeechProvider } from "./speech-provider.js";

const PROVIDER_ID = "vydra";
const VYDRA_KLING_MODEL = "kling";
const DEFAULT_VYDRA_VIDEO_TIMEOUT_MS = 120_000;

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Vydra Provider",
  description: "Vydra image, video, and speech provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Vydra",
      docsPath: "/providers/vydra",
      envVars: ["VYDRA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Vydra API key",
          hint: "Image, video, and speech API key",
          optionKey: "vydraApiKey",
          flagName: "--vydra-api-key",
          envVar: "VYDRA_API_KEY",
          promptMessage: "Enter Vydra API key",
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyVydraConfig(cfg),
          wizard: {
            choiceId: "vydra-api-key",
            choiceLabel: "Vydra API key",
            choiceHint: "Image, video, and speech API key",
            groupId: "vydra",
            groupLabel: "Vydra",
            groupHint: "Image, video, and speech",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerSpeechProvider(buildVydraSpeechProvider());
    api.registerImageGenerationProvider({
      id: "vydra",
      label: "Vydra",
      defaultModel: DEFAULT_VYDRA_IMAGE_MODEL,
      models: [DEFAULT_VYDRA_IMAGE_MODEL],
      isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "vydra", ...ctx }),
      capabilities: {
        generate: {
          maxCount: 1,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
        edit: {
          enabled: false,
          maxCount: 1,
          maxInputImages: 0,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
      },
      async generateImage(req) {
        if ((req.inputImages?.length ?? 0) > 0) {
          throw new Error(
            "Vydra image generation currently supports text-to-image only in the Vydra plugin.",
          );
        }
        if ((req.count ?? 1) > 1) {
          throw new Error("Vydra image generation supports at most one image per request.");
        }

        const model = req.model?.trim() || DEFAULT_VYDRA_IMAGE_MODEL;
        const generated = await runVydraGeneration({
          cfg: req.cfg,
          agentDir: req.agentDir,
          authStore: req.authStore,
          kind: "image",
          model,
          body: {
            prompt: req.prompt,
            model: "text-to-image",
          },
          timeoutMs: req.timeoutMs,
          ssrfPolicy: req.ssrfPolicy,
        });
        return {
          images: [generated.asset],
          model,
          metadata: {
            jobId: generated.jobId,
            imageUrl: generated.resultUrl,
            status: generated.status,
          },
        };
      },
    });
    api.registerVideoGenerationProvider({
      id: "vydra",
      label: "Vydra",
      defaultModel: DEFAULT_VYDRA_VIDEO_MODEL,
      models: [DEFAULT_VYDRA_VIDEO_MODEL, VYDRA_KLING_MODEL],
      isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "vydra", ...ctx }),
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
    });
  },
});
