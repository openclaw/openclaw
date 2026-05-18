import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import {
  DEFAULT_COMFY_MODEL,
  setComfyFetchGuardForTesting,
  isComfyCapabilityConfigured,
  isComfyDimensionsConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

export { setComfyFetchGuardForTesting };

export function buildComfyImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "comfy",
    label: "ComfyUI",
    defaultModel: DEFAULT_COMFY_MODEL,
    models: [DEFAULT_COMFY_MODEL],
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        cfg,
        agentDir,
        capability: "image",
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: isComfyDimensionsConfigured(cfg),
        supportsAspectRatio: isComfyDimensionsConfigured(cfg),
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
    async generateImage(req: ImageGenerationRequest) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Comfy image generation currently supports at most one reference image");
      }

      const result = await runComfyWorkflow({
        cfg: req.cfg,
        agentDir: req.agentDir,
        authStore: req.authStore,
        prompt: req.prompt,
        model: req.model,
        timeoutMs: req.timeoutMs,
        capability: "image",
        outputKinds: ["images"],
        inputImage: req.inputImages?.[0],
        aspectRatio: req.aspectRatio,
        size: req.size,
      });

      const images: GeneratedImageAsset[] = result.assets.map((asset) => ({
        buffer: asset.buffer,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        metadata: {
          nodeId: asset.nodeId,
          promptId: result.promptId,
        },
      }));

      return {
        images,
        model: result.model,
        metadata: {
          promptId: result.promptId,
          outputNodeIds: result.outputNodeIds,
        },
      };
    },
  };
}
