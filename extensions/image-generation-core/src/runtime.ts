import {
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "openclaw/plugin-sdk/media-generation-runtime-shared";
import {
  createSubsystemLogger,
  describeFailoverError,
  getImageGenerationProvider,
  isFailoverError,
  listImageGenerationProviders,
  parseImageGenerationModelRef,
  type AuthProfileStore,
  type FallbackAttempt,
  type GeneratedImageAsset,
  type ImageGenerationResolution,
  type ImageGenerationResult,
  type ImageGenerationSourceImage,
  type OpenClawConfig,
} from "../api.js";

const log = createSubsystemLogger("image-generation");

export type GenerateImageParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
};

export type GenerateImageRuntimeResult = {
  images: GeneratedImageAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
};

function buildNoImageGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "image-generation",
    modelConfigKey: "imageGenerationModel",
    providers: listImageGenerationProviders(cfg),
    fallbackSampleRef: "google/gemini-3-pro-image-preview",
  });
}

export function listRuntimeImageGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listImageGenerationProviders(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
): Promise<GenerateImageRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getImageGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const result: ImageGenerationResult = await provider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        count: params.count,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        inputImages: params.inputImages,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        metadata: result.metadata,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? (err instanceof Error ? err.message : String(err)),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      log.debug(`image-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    capabilityLabel: "image generation",
    attempts,
    lastError,
  });
}
