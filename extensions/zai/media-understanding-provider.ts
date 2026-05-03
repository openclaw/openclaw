import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
  type ImageDescriptionRequest,
  type ImageDescriptionResult,
  type ImagesDescriptionRequest,
  type ImagesDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";

const ZAI_PROVIDER_ID = "zai";

const ZAI_VISION_MODEL_IDS = new Set(["glm-4.6v", "glm-4.5v", "glm-5v-turbo"]);

/** Matches /api/coding/paas/v4, /api/coding/paas/v5, etc. */
const CODING_PATH_RE = /\/api\/coding(\/paas\/v\d+)/;

export function isZaiVisionModel(modelId: string): boolean {
  return ZAI_VISION_MODEL_IDS.has(modelId);
}

export function isCodingBaseUrl(baseUrl: string): boolean {
  return CODING_PATH_RE.test(baseUrl);
}

export function toStandardBaseUrl(baseUrl: string): string {
  return baseUrl.replace(CODING_PATH_RE, "/api$1");
}

/**
 * Patches the provider config's baseUrl from coding endpoint to standard endpoint
 * for ZAI vision model requests.
 *
 * NOTE: This creates a shallow clone of cfg per-request. In concurrent scenarios,
 * non-vision ZAI requests that write back the shared models.json cache could
 * theoretically cause intermittent 404s if the underlying describeImageWithModel
 * re-resolves the provider config from global state. This is a best-effort fix
 * that handles the common single-request case; a more robust solution would
 * require provider-level URL routing rather than per-request cfg patching.
 */
export function patchCfgForVisionModel<T extends { cfg: unknown; provider: string; model: string }>(
  params: T,
): T {
  if (params.provider !== ZAI_PROVIDER_ID || !isZaiVisionModel(params.model)) {
    return params;
  }
  const cfg = params.cfg as Record<string, unknown>;
  const providers = cfg?.models ? (cfg.models as Record<string, unknown>).providers : undefined;
  const providerCfg = (providers as Record<string, Record<string, unknown>> | undefined)?.[
    ZAI_PROVIDER_ID
  ];
  const baseUrl = typeof providerCfg?.baseUrl === "string" ? providerCfg.baseUrl : "";
  if (!baseUrl || !isCodingBaseUrl(baseUrl)) {
    return params;
  }
  const standardBaseUrl = toStandardBaseUrl(baseUrl);
  return {
    ...params,
    cfg: {
      ...cfg,
      models: {
        ...(cfg.models as Record<string, unknown>),
        providers: {
          ...((cfg.models as Record<string, unknown>).providers as Record<string, unknown>),
          [ZAI_PROVIDER_ID]: {
            ...providerCfg,
            baseUrl: standardBaseUrl,
          },
        },
      },
    },
  };
}

async function zaiDescribeImage(req: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
  const patched = patchCfgForVisionModel(req);
  return describeImageWithModel(patched);
}

async function zaiDescribeImages(req: ImagesDescriptionRequest): Promise<ImagesDescriptionResult> {
  const patched = patchCfgForVisionModel(req);
  return describeImagesWithModel(patched);
}

export const zaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: ZAI_PROVIDER_ID,
  capabilities: ["image"],
  defaultModels: { image: "glm-4.6v" },
  autoPriority: { image: 60 },
  describeImage: zaiDescribeImage,
  describeImages: zaiDescribeImages,
};
