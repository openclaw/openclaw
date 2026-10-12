import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";
import { hasAnthropicVertexAvailableAuth } from "./region.js";

export function mergeImplicitAnthropicVertexProvider(params: {
  existing?: ModelProviderConfig;
  implicit: ModelProviderConfig;
}): ModelProviderConfig {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

export function resolveImplicitAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}

export async function runAnthropicVertexCatalog(ctx: ProviderCatalogContext) {
  const implicit = resolveImplicitAnthropicVertexProvider({
    env: ctx.env,
  });
  if (!implicit) {
    return null;
  }
  return {
    provider: implicit,
  };
}
