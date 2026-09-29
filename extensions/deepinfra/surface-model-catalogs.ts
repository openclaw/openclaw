import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  VideoGenerationModelCapabilitiesContext,
  VideoGenerationProviderCapabilities,
} from "openclaw/plugin-sdk/video-generation";
import { DEEPINFRA_VIDEO_ASPECT_RATIOS, DEEPINFRA_VIDEO_DURATIONS } from "./media-models.js";
import { discoverDeepInfraSurfaces } from "./provider-models.js";

const PROVIDER_ID = "deepinfra";

// Canonical DeepInfra-wide video-gen shape. Wire per-model hints
// (metadata.supported_durations etc.) in here once the backend emits them.
export function buildDeepInfraVideoModelCapabilities(): VideoGenerationProviderCapabilities {
  return {
    providerOptions: {
      seed: "number",
      negative_prompt: "string",
      negativePrompt: "string",
      style: "string",
    },
    generate: {
      maxVideos: 1,
      maxDurationSeconds: 8,
      supportedDurationSeconds: [...DEEPINFRA_VIDEO_DURATIONS],
      supportsAspectRatio: true,
      aspectRatios: [...DEEPINFRA_VIDEO_ASPECT_RATIOS],
    },
    imageToVideo: { enabled: false },
    videoToVideo: { enabled: false },
  };
}

async function listDeepInfraGenerationCatalog(
  ctx: UnifiedModelCatalogProviderContext,
  kind: "image_generation" | "video_generation",
): Promise<readonly UnifiedModelCatalogEntry<VideoGenerationProviderCapabilities>[] | null> {
  const { discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (!discoveryApiKey) {
    return null;
  }
  const catalog = await discoverDeepInfraSurfaces({ hasApiKey: true, env: ctx.env });
  const models = kind === "image_generation" ? catalog.imageGen : catalog.videoGen;
  // Non-live and empty surfaces leave the static fallback authoritative.
  if (!catalog.live || models.length === 0) {
    return null;
  }
  return models.map((model) => ({
    kind,
    provider: PROVIDER_ID,
    model: model.id,
    source: "live",
    ...(model.name ? { label: model.name } : {}),
    ...(kind === "video_generation"
      ? { capabilities: buildDeepInfraVideoModelCapabilities() }
      : {}),
  }));
}

export function listDeepInfraImageGenCatalog(ctx: UnifiedModelCatalogProviderContext) {
  return listDeepInfraGenerationCatalog(ctx, "image_generation");
}

export function listDeepInfraVideoGenCatalog(ctx: UnifiedModelCatalogProviderContext) {
  return listDeepInfraGenerationCatalog(ctx, "video_generation");
}

export async function resolveDeepInfraVideoModelCapabilities(
  ctx: VideoGenerationModelCapabilitiesContext,
): Promise<VideoGenerationProviderCapabilities | undefined> {
  // Model id may arrive bare or `deepinfra/`-prefixed.
  const rawId = typeof ctx.model === "string" ? ctx.model : "";
  const normalized = rawId.startsWith(`${PROVIDER_ID}/`)
    ? rawId.slice(PROVIDER_ID.length + 1)
    : rawId;
  const catalog = await discoverDeepInfraSurfaces({
    env: process.env,
  });
  const entry =
    catalog.videoGen.find((m) => m.id === normalized) ??
    catalog.videoGen.find((m) => m.id === rawId);
  return entry ? buildDeepInfraVideoModelCapabilities() : undefined;
}
