/** Cold adapter for provider-owned OpenAI model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderModelRoutes } from "../plugins/provider-model-routes.js";
import type { ProviderModelRouteResolution } from "../plugins/provider-policy-surface.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

const OPENAI_PROVIDER_ID = "openai";

/** Resolves concrete ordered OpenAI routes without loading the full provider runtime. */
export function resolveOpenAIModelRoutes(params: {
  provider?: string;
  modelId?: string;
  api?: ModelApi | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ProviderModelRouteResolution | null {
  if (normalizeProviderId(params.provider ?? "") !== OPENAI_PROVIDER_ID) {
    return null;
  }
  return resolveProviderModelRoutes({
    provider: OPENAI_PROVIDER_ID,
    modelId: params.modelId ? splitTrailingAuthProfile(params.modelId).model : undefined,
    api: params.api,
    baseUrl: params.baseUrl,
    config: params.config,
    environment: { baseUrl: (params.env ?? process.env).OPENAI_BASE_URL },
  });
}
