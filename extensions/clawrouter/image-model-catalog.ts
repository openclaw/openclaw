import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  fetchWithTimeoutGuarded,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfigWithOriginTrust,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterApiBaseUrl } from "./base-url.js";

// Qualified by ClawRouter's JSON Images API contract; not a list of key grants.
const SUPPORTED_IMAGE_MODELS = new Set([
  "openai/gpt-image-2.5-flare",
  "openai/gpt-image-2.5-flare-2026-09-08",
  "openai/gpt-image-2.5-sunburst",
  "openai/gpt-image-2.5-sunburst-2026-09-08",
]);
export const CLAWROUTER_IMAGE_CAPABILITIES: ImageGenerationProvider["capabilities"] = {
  generate: {
    maxCount: 10,
    supportsSize: true,
    supportsAspectRatio: false,
    supportsResolution: false,
  },
  edit: { enabled: false },
  output: {
    qualities: ["low", "medium", "high", "xhigh", "max", "auto"],
    formats: ["png", "jpeg", "webp"],
    backgrounds: ["auto", "opaque", "transparent"],
  },
};

type ImageLimits = {
  maxPromptCharacters: number;
  maxImages: number;
  dimensionMultiple: number;
  minPixels: number;
  maxPixels: number;
  maxEdge: number;
  maxAspectRatio: number;
};
type ImageCatalogEntry = UnifiedModelCatalogEntry<ImageGenerationProvider["capabilities"]> & {
  limits: ImageLimits;
};

function parseImageLimits(value: unknown): ImageLimits | undefined {
  const pricing = asOptionalRecord(value);
  const generation =
    pricing?.unit === "image_token" ? asOptionalRecord(pricing.generation) : undefined;
  const positiveInteger = (key: string) => {
    const number = generation?.[key];
    return typeof number === "number" && Number.isSafeInteger(number) && number > 0
      ? number
      : undefined;
  };
  const maxPromptCharacters = positiveInteger("maxPromptCharacters");
  const maxImages = positiveInteger("maxImages");
  const dimensionMultiple = positiveInteger("dimensionMultiple");
  const minPixels = positiveInteger("minPixels");
  const maxPixels = positiveInteger("maxPixels");
  const maxEdge = positiveInteger("maxEdge");
  const maxAspectRatio = positiveInteger("maxAspectRatio");
  if (
    !maxPromptCharacters ||
    !maxImages ||
    !dimensionMultiple ||
    !minPixels ||
    !maxPixels ||
    !maxEdge ||
    !maxAspectRatio ||
    minPixels > maxPixels
  ) {
    return undefined;
  }
  return {
    maxPromptCharacters: Math.min(32_000, maxPromptCharacters),
    maxImages: Math.min(10, maxImages),
    dimensionMultiple,
    minPixels,
    maxPixels,
    maxEdge,
    maxAspectRatio,
  };
}

export function assertClawRouterImageLimits(
  req: ImageGenerationRequest,
  limits: ImageLimits,
): void {
  if (
    (req.count ?? 1) > limits.maxImages ||
    Array.from(req.prompt).length > limits.maxPromptCharacters
  ) {
    throw new Error(
      "ClawRouter image request exceeds the current catalog's prompt or image count limit.",
    );
  }
  if (!req.size || req.size === "auto") {
    return;
  }
  const match = /^(\d+)x(\d+)$/u.exec(req.size);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  const pixels = width * height;
  if (
    !match ||
    width % limits.dimensionMultiple ||
    height % limits.dimensionMultiple ||
    pixels < limits.minPixels ||
    pixels > limits.maxPixels ||
    Math.max(width, height) > limits.maxEdge ||
    Math.max(width / height, height / width) > limits.maxAspectRatio
  ) {
    throw new Error("ClawRouter image size is outside the current catalog's generation bounds.");
  }
}

export function isSupportedClawRouterImageModel(model: string): boolean {
  return SUPPORTED_IMAGE_MODELS.has(model);
}

export function resolveClawRouterImageHttpContext(
  req: Pick<ImageGenerationRequest, "cfg">,
  apiKey: string,
) {
  const providerConfig = req.cfg.models?.providers?.clawrouter;
  const baseUrl = normalizeClawRouterApiBaseUrl(providerConfig?.baseUrl);
  const context = resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "clawrouter",
    capability: "image",
    transport: "http",
    baseUrl,
    defaultBaseUrl: baseUrl,
    request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
  });
  const providerHeaders = sanitizeConfiguredModelProviderRequest({
    headers: providerConfig?.headers,
  })?.headers;
  const headers = new Headers(providerHeaders);
  context.headers.forEach((value, name) => headers.set(name, value));
  // The same resolved ClawRouter credential owns discovery and paid dispatch.
  headers.set("Authorization", "Bearer " + apiKey);
  headers.set("X-ClawRouter-Client", "openclaw");
  headers.set("Accept", "application/json");
  return {
    ...context,
    headers,
    ssrfPolicy: context.trustConfiguredBaseUrlOrigin
      ? { allowedOrigins: [new URL(baseUrl).origin] }
      : undefined,
  };
}

export function assertClawRouterImageResponseOk(response: Response, operation: string): void {
  if (!response.ok) {
    // Do not echo arbitrary service error bodies (which can contain credentials/content).
    throw new Error(
      operation +
        " failed (HTTP " +
        response.status +
        "). Check the ClawRouter key, image grants and budget.",
    );
  }
}

export async function fetchClawRouterImageModels(params: {
  context: ReturnType<typeof resolveClawRouterImageHttpContext>;
  timeoutMs: () => number;
  signal?: AbortSignal;
  ssrfPolicy?: ImageGenerationRequest["ssrfPolicy"];
}): Promise<ImageCatalogEntry[]> {
  const { context } = params;
  params.signal?.throwIfAborted();
  const { response, release } = await fetchWithTimeoutGuarded(
    context.baseUrl.replace(/\/+$/u, "") + "/catalog",
    { method: "GET", headers: context.headers, signal: params.signal },
    params.timeoutMs(),
    fetch,
    {
      ssrfPolicy: mergeSsrFPolicies(
        params.ssrfPolicy,
        context.ssrfPolicy,
        context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
      ),
      dispatcherPolicy: context.dispatcherPolicy,
      auditContext: "clawrouter.image-catalog",
    },
  );
  try {
    assertClawRouterImageResponseOk(response, "ClawRouter image catalog");
    const payload = asOptionalRecord(
      await readProviderJsonResponse(response, "clawrouter.image-catalog", {
        maxBytes: 1024 * 1024,
        timeoutMs: params.timeoutMs,
      }),
    );
    if (payload?.version !== "clawrouter.client-catalog.v1" || !Array.isArray(payload.providers)) {
      throw new Error("ClawRouter image catalog response malformed; refresh or update ClawRouter.");
    }
    const result: ImageCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const providerValue of payload.providers) {
      const provider = asOptionalRecord(providerValue);
      if (
        provider?.id !== "openai" ||
        provider.allowed !== true ||
        provider.executable !== true ||
        !Array.isArray(provider.models) ||
        !Array.isArray(provider.offers)
      ) {
        continue;
      }
      for (const modelValue of provider.models) {
        const model = asOptionalRecord(modelValue);
        const id = normalizeOptionalString(model?.id);
        if (
          !id ||
          seen.has(id) ||
          !isSupportedClawRouterImageModel(id) ||
          !Array.isArray(model?.capabilities) ||
          !model.capabilities.includes("image.generation")
        ) {
          continue;
        }
        const eligible = provider.offers.some((value) => {
          const offer = asOptionalRecord(value);
          return (
            offer?.endpoint === "images_generations" &&
            offer.modelId === id &&
            offer.transport === "http" &&
            offer.routeKind === "unified" &&
            offer.route === "/v1/images/generations" &&
            offer.eligible === true &&
            (offer.affordability === "exact-covered" || offer.affordability === "request-dependent")
          );
        });
        if (!eligible) {
          continue;
        }
        const limits = parseImageLimits(model?.pricing);
        if (!limits) {
          continue;
        }
        seen.add(id);
        result.push({
          kind: "image_generation",
          provider: "clawrouter",
          model: id,
          label: normalizeOptionalString(model?.displayName) ?? id,
          source: "live",
          modes: ["generate"],
          capabilities: {
            ...CLAWROUTER_IMAGE_CAPABILITIES,
            generate: { ...CLAWROUTER_IMAGE_CAPABILITIES.generate, maxCount: limits.maxImages },
          },
          limits,
        });
      }
    }
    params.signal?.throwIfAborted();
    return result;
  } finally {
    void response.body?.cancel().catch(() => undefined);
    await release();
  }
}

export async function listClawRouterImageModelCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<UnifiedModelCatalogEntry[]> {
  const selected = ctx.resolveProviderAuth("clawrouter");
  if (!selected.apiKey && !selected.discoveryApiKey && !selected.profileId) {
    return [];
  }
  const auth = await resolveApiKeyForProvider({
    provider: "clawrouter",
    cfg: ctx.config,
    agentDir: ctx.agentDir,
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
    ...(selected.profileId ? { profileId: selected.profileId, lockedProfile: true } : {}),
  });
  if (!auth.apiKey) {
    return [];
  }
  // No static/failure fallback and no retained authorization cache.
  return fetchClawRouterImageModels({
    context: resolveClawRouterImageHttpContext({ cfg: ctx.config }, auth.apiKey),
    timeoutMs: () => ctx.timeoutMs ?? 10_000,
    signal: ctx.signal,
  });
}
