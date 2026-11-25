import type { MusicGenerationSourceImage } from "openclaw/plugin-sdk/music-generation";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type { VideoGenerationSourceAsset } from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_COMFY_MODEL,
  isComfyCapabilityConfigured,
  isComfyCapabilityConfiguredAsync,
  runComfyWorkflow,
} from "./workflow-runtime.js";

const PROVIDER_ID = "comfy";
const COMFY_MAX_INPUT_IMAGES = 1;

type ComfyReadinessContext = Omit<Parameters<typeof isComfyCapabilityConfigured>[0], "capability">;

function comfyProviderDefaults(capability: "image" | "music" | "video") {
  return {
    id: PROVIDER_ID,
    label: "ComfyUI",
    defaultModel: DEFAULT_COMFY_MODEL,
    models: [DEFAULT_COMFY_MODEL],
    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured: ({ cfg, agentDir }: ComfyReadinessContext) =>
      isComfyCapabilityConfigured({ cfg, agentDir, capability }),
    isConfiguredAsync: ({ cfg, agentDir }: ComfyReadinessContext) =>
      isComfyCapabilityConfiguredAsync({ cfg, agentDir, capability }),
  };
}

function resolveInputImage(inputImage: MusicGenerationSourceImage | undefined) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer) {
    throw new Error("Comfy music generation requires loaded reference image bytes.");
  }
  return {
    buffer: inputImage.buffer,
    mimeType: inputImage.mimeType ?? "image/png",
    fileName: inputImage.fileName,
  };
}

function toComfyInputImage(inputImage?: VideoGenerationSourceAsset) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer || !inputImage.mimeType) {
    throw new Error("Comfy video generation requires a local reference image file");
  }
  return {
    buffer: inputImage.buffer,
    mimeType: inputImage.mimeType,
    fileName: inputImage.fileName,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "ComfyUI Provider",
  description: "Bundled ComfyUI workflow media generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ComfyUI",
      docsPath: "/providers/comfy",
      envVars: ["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "cloud-api-key",
          label: "Comfy Cloud API key",
          hint: "API key for Comfy Cloud workflow runs",
          optionKey: "comfyApiKey",
          flagName: "--comfy-api-key",
          envVar: "COMFY_API_KEY",
          promptMessage: "Enter Comfy Cloud API key",
          wizard: {
            choiceId: "comfy-cloud-api-key",
            choiceLabel: "Comfy Cloud API key",
            choiceHint: "Required for cloud workflows",
            groupId: "comfy",
            groupLabel: "ComfyUI",
            groupHint: "Local or cloud workflows",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerImageGenerationProvider({
      ...comfyProviderDefaults("image"),
      capabilities: {
        generate: {
          maxCount: 1,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
        edit: {
          enabled: true,
          maxCount: 1,
          maxInputImages: 1,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
      },
      async generateImage(req) {
        if ((req.inputImages?.length ?? 0) > 1) {
          throw new Error("Comfy image generation currently supports at most one reference image");
        }

        const result = await runComfyWorkflow({
          ...req,
          capability: "image",
          inputImage: req.inputImages?.[0],
        });

        return {
          images: result.assets,
          model: result.model,
          metadata: result.metadata,
        };
      },
    });
    api.registerMusicGenerationProvider({
      ...comfyProviderDefaults("music"),
      capabilities: {
        generate: {},
        edit: {
          enabled: true,
          maxInputImages: COMFY_MAX_INPUT_IMAGES,
        },
      },
      async generateMusic(req) {
        if ((req.inputImages?.length ?? 0) > COMFY_MAX_INPUT_IMAGES) {
          throw new Error(
            `Comfy music generation supports at most ${COMFY_MAX_INPUT_IMAGES} reference image.`,
          );
        }

        const result = await runComfyWorkflow({
          ...req,
          capability: "music",
          inputImage: resolveInputImage(req.inputImages?.[0]),
        });

        return {
          tracks: result.assets.map(({ buffer, mimeType, fileName }) => ({
            buffer,
            mimeType,
            fileName,
          })),
          model: result.model,
          metadata: {
            ...result.metadata,
            inputImageCount: req.inputImages?.length ?? 0,
          },
        };
      },
    });
    api.registerVideoGenerationProvider({
      ...comfyProviderDefaults("video"),
      capabilities: {
        generate: {
          maxVideos: 1,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
          supportsAudio: false,
          supportsWatermark: false,
        },
        imageToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputImages: 1,
          supportsSize: false,
          supportsAspectRatio: false,
          supportsResolution: false,
          supportsAudio: false,
          supportsWatermark: false,
        },
        videoToVideo: {
          enabled: false,
        },
      },
      async generateVideo(req) {
        if ((req.inputImages?.length ?? 0) > 1) {
          throw new Error("Comfy video generation currently supports at most one reference image");
        }
        if ((req.inputVideos?.length ?? 0) > 0) {
          throw new Error("Comfy video generation does not support input videos");
        }

        const result = await runComfyWorkflow({
          ...req,
          capability: "video",
          inputImage: toComfyInputImage(req.inputImages?.[0]),
        });

        return {
          videos: result.assets,
          model: result.model,
          metadata: result.metadata,
        };
      },
    });
  },
});
