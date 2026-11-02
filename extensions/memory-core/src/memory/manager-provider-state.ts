import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  resolveEmbeddingProviderFallbackModel,
  resolveEmbeddingProviderFallbackRemote,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
} from "./embeddings.js";

export type MemoryProviderLifecycleState =
  | {
      mode: "pending";
      requestedProvider: string;
    }
  | {
      mode: "active";
      providerId: string;
    }
  | {
      mode: "degraded";
      providerId: string;
      reason: string;
      code?: string;
    }
  | {
      mode: "fallback-active";
      providerId: string;
      fallbackFrom: string;
      reason: string;
    }
  | {
      mode: "fts-only";
      reason: string;
      attemptedProviderId?: string;
    };

export function resolveMemoryProviderLifecycle(
  result: EmbeddingProviderResult,
): MemoryProviderLifecycleState {
  if (result.provider && result.fallbackFrom) {
    return {
      mode: "fallback-active",
      providerId: result.provider.id,
      fallbackFrom: result.fallbackFrom,
      reason: result.fallbackReason ?? "fallback activated",
    };
  }
  if (result.provider) {
    return { mode: "active", providerId: result.provider.id };
  }
  return {
    mode: "fts-only",
    reason: result.providerUnavailableReason ?? "No embedding provider available",
    attemptedProviderId: result.requestedProvider,
  };
}

export function resolveFallbackCurrentProviderId(params: {
  provider: EmbeddingProvider | null;
  lifecycle: MemoryProviderLifecycleState;
}): string | null {
  if (params.provider) {
    return params.provider.id;
  }
  if (params.lifecycle.mode === "degraded") {
    return params.lifecycle.providerId;
  }
  return null;
}

export function resolveMemoryPrimaryProviderRequest(params: {
  settings: ResolvedMemorySearchConfig;
}) {
  return {
    provider: params.settings.provider,
    model: params.settings.model,
    remote: params.settings.remote,
    inputType: params.settings.inputType,
    queryInputType: params.settings.queryInputType,
    documentInputType: params.settings.documentInputType,
    outputDimensionality: params.settings.outputDimensionality,
    fallback: params.settings.fallback,
    local: params.settings.local,
  };
}

export function resolveMemoryFallbackProviderRequest(params: {
  cfg: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
  currentProviderId: string | null;
}) {
  const fallback = params.settings.fallback;
  if (
    !fallback ||
    fallback === "none" ||
    !params.currentProviderId ||
    fallback === params.currentProviderId
  ) {
    return null;
  }
  return {
    ...resolveMemoryPrimaryProviderRequest({ settings: params.settings }),
    provider: fallback,
    model: resolveEmbeddingProviderFallbackModel(fallback, params.settings.model, params.cfg),
    remote: resolveEmbeddingProviderFallbackRemote(params.settings.remote),
    fallback: "none" as const,
  };
}
