import type { Api, Model } from "../../llm/types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
export type {
  ResolvedModelRuntime,
  ResolvedModelRuntimeAuth,
  ResolvedModelRuntimeRef,
  ResolvedModelRuntimeSource,
  ResolvedModelRuntimeTransport,
} from "../resolved-model-runtime.types.js";
import { normalizeProviderId } from "../model-selection.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import type {
  ResolvedModelRuntime,
  ResolvedModelRuntimeSource,
} from "../resolved-model-runtime.types.js";
import { normalizeResolvedTransportApi } from "./model.inline-provider.js";

function resolveAuthProviderRefs(params: { provider: string; api?: string }): string[] {
  const refs = [params.provider];
  const apiRef = params.api?.trim();
  if (apiRef && normalizeProviderId(apiRef) !== normalizeProviderId(params.provider)) {
    refs.push(apiRef);
  }
  return [...new Set(refs)];
}

function resolvePreferredAuthProvider(providerRefs: readonly string[]): string | undefined {
  return providerRefs.length > 1 ? providerRefs[providerRefs.length - 1] : providerRefs[0];
}

export function createResolvedModelRuntime(params: {
  provider: string;
  modelId: string;
  model: Model<Api>;
  source?: ResolvedModelRuntimeSource;
}): ResolvedModelRuntime {
  const api = normalizeResolvedTransportApi(params.model.api);
  const providerRefs = resolveAuthProviderRefs({
    provider: params.provider,
    api: api ?? params.model.api,
  });
  const request = getModelProviderRequestTransport(params.model);
  return {
    ref: {
      provider: params.provider,
      modelId: params.modelId,
    },
    model: params.model as ProviderRuntimeModel,
    transport: {
      ...(api ? { api } : {}),
      ...(params.model.baseUrl ? { baseUrl: params.model.baseUrl } : {}),
      ...(params.model.headers ? { headers: params.model.headers as Record<string, string> } : {}),
      ...(request ? { request } : {}),
    },
    auth: {
      providerRefs,
      preferredProvider: resolvePreferredAuthProvider(providerRefs),
      ...(api ? { modelApi: api } : {}),
      ...(params.model.baseUrl ? { modelBaseUrl: params.model.baseUrl } : {}),
    },
    source: params.source ?? {},
  };
}

export function withResolvedModelRuntimeModel(
  runtime: ResolvedModelRuntime,
  model: Model<Api>,
): ResolvedModelRuntime {
  return createResolvedModelRuntime({
    provider: runtime.ref.provider,
    modelId: runtime.ref.modelId,
    model,
    source: runtime.source,
  });
}
