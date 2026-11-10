import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { applyAgentDefaultMediaModel } from "openclaw/plugin-sdk/provider-onboard";
import { DEFAULT_VYDRA_IMAGE_MODEL, DEFAULT_VYDRA_VIDEO_MODEL } from "./defaults.js";
import { runVydraGeneration } from "./shared.js";
import { buildVydraSpeechProvider } from "./speech-provider.js";

const PROVIDER_ID = "vydra";
const VYDRA_KLING_MODEL = "kling";
const DEFAULT_VYDRA_VIDEO_TIMEOUT_MS = 120_000;

function requireKlingReferenceUrl(value: string | undefined, kind: "image" | "video"): string {
  const url = value?.trim();
  const parsed = url ? URL.parse(url) : null;
  if (
    !url ||
    url.length > 2_048 ||
    /[\s\\]/.test(url) ||
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`Vydra kling requires a remote HTTPS ${kind} URL reference.`);
  }
  return url;
}

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
          applyConfig: (cfg) => applyAgentDefaultMediaModel(cfg, "image", "vydra/grok-imagine"),
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
      catalogByModel: {
        [DEFAULT_VYDRA_VIDEO_MODEL]: { modes: ["generate"] },
        [VYDRA_KLING_MODEL]: { modes: ["videoToVideo"] },
      },
      isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: "vydra", ...ctx }),
      capabilities: {
        generate: {
          maxVideos: 1,
        },
        imageToVideo: {
          enabled: false,
        },
        videoToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputImages: 0,
          maxInputImagesByModel: { [VYDRA_KLING_MODEL]: 1 },
          maxInputVideos: 0,
          maxInputVideosByModel: { [VYDRA_KLING_MODEL]: 1 },
        },
      },
      async generateVideo(req) {
        if ((req.inputAudios?.length ?? 0) > 0) {
          throw new Error("Vydra video generation does not support audio reference inputs.");
        }

        const model = req.model?.trim() || DEFAULT_VYDRA_VIDEO_MODEL;
        const body: Record<string, unknown> = { prompt: req.prompt };
        if (model === VYDRA_KLING_MODEL) {
          if (req.inputImages?.length !== 1 || req.inputVideos?.length !== 1) {
            throw new Error(
              "Vydra kling requires exactly one image and one motion video reference.",
            );
          }
          const imageUrl = requireKlingReferenceUrl(req.inputImages[0]?.url, "image");
          const videoUrl = requireKlingReferenceUrl(req.inputVideos[0]?.url, "video");
          if (new URL(imageUrl).href === new URL(videoUrl).href) {
            throw new Error("Vydra kling requires distinct image and motion video URL references.");
          }
          body.image_url = imageUrl;
          body.video_url = videoUrl;
        } else if ((req.inputVideos?.length ?? 0) > 0) {
          throw new Error(
            `Vydra ${model} does not support video reference inputs in the Vydra plugin.`,
          );
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
