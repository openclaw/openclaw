import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import {
  asFiniteNumber,
  finiteSecondsToTimerSafeMilliseconds,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Model } from "../../llm/types.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { normalizeModelCompat } from "../../plugins/provider-model-compat.js";
import { resolveProviderPolicySurface } from "../../plugins/provider-public-artifacts.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import { canonicalizeOpenAIModelId } from "../openai-routing.js";
import { inheritModelProviderRequestRouteFacts } from "../provider-request-config.js";
import {
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
} from "./model.inline-provider.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.types.js";
export type { ProviderRuntimeHooks } from "./model.provider-hooks.types.js";
export { resolveProviderTransport } from "./model.provider-transport.js";

let targetProviderRuntimeHooks: ProviderRuntimeHooks | undefined;
let defaultProviderRuntimeHooks: ProviderRuntimeHooks | undefined;

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
};

export function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  skipAgentDiscovery?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  if (params?.runtimeHooks) {
    return params.runtimeHooks;
  }
  // Bind provider hooks only when model resolution requests them.
  targetProviderRuntimeHooks ??= {
    resolveToolSearchMode: (context) => {
      const metadataSnapshot = getCurrentPluginMetadataSnapshot({
        allowScopedSnapshot: true,
        allowWorkspaceScopedSnapshot: true,
      });
      const metadata = {
        manifestRegistry: metadataSnapshot?.manifestRegistry,
      };
      const policy =
        resolveProviderPolicySurface(context.provider, metadata)?.resolveToolSearchMode ??
        (context.api !== context.provider
          ? resolveProviderPolicySurface(context.api, metadata)?.resolveToolSearchMode
          : undefined);
      return policy?.(context);
    },
    buildProviderUnknownModelHintWithPlugin,
    prepareProviderDynamicModel,
    runProviderDynamicModel,
    shouldPreferProviderRuntimeResolvedModel,
    normalizeProviderResolvedModelWithPlugin,
    // Target-provider resolution keeps owner hooks, but avoids broad
    // cross-provider hooks that can load unrelated bundled provider runtimes.
    applyProviderResolvedTransportWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
  };
  if (params?.skipAgentDiscovery) {
    return targetProviderRuntimeHooks;
  }
  return (defaultProviderRuntimeHooks ??= {
    ...targetProviderRuntimeHooks,
    applyProviderResolvedTransportWithPlugin,
    normalizeProviderTransportWithPlugin,
  });
}

function canonicalizeLegacyResolvedModel(params: { provider: string; model: Model }): Model {
  const canonicalModelId = canonicalizeOpenAIModelId(params.provider, params.model.id);
  if (canonicalModelId === params.model.id) {
    return params.model;
  }
  return {
    ...params.model,
    id: canonicalModelId,
    name:
      canonicalizeOpenAIModelId(params.provider, params.model.name) === canonicalModelId
        ? canonicalModelId
        : params.model.name,
  };
}

function applyResolvedTransportFallback(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
  model: Model;
}): Model | undefined {
  const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.model.id,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.model.id,
      api: params.model.api,
      baseUrl: params.model.baseUrl,
    },
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  if (!normalized) {
    return undefined;
  }
  const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return undefined;
  }
  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  };
}

export function normalizeResolvedModel(params: {
  provider: string;
  model: Model;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model {
  const normalizeModelCost = (cost: unknown): Model["cost"] => {
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const record = cost as Partial<Model["cost"]>;
    const input = asFiniteNumber(record.input) ?? 0;
    const output = asFiniteNumber(record.output) ?? 0;
    const cacheRead = asFiniteNumber(record.cacheRead) ?? 0;
    const cacheWrite = asFiniteNumber(record.cacheWrite) ?? 0;
    if (
      input === record.input &&
      output === record.output &&
      cacheRead === record.cacheRead &&
      cacheWrite === record.cacheWrite
    ) {
      return record as Model["cost"];
    }
    return { ...cost, input, output, cacheRead, cacheWrite };
  };

  const normalizedInputModel = {
    ...params.model,
    input: resolveProviderModelInput({
      provider: params.provider,
      modelId: params.model.id,
      modelName: params.model.name,
      input: params.model.input,
    }),
    cost: normalizeModelCost(params.model.cost),
  } as Model & ProviderRuntimeModel;
  const runtimeHooks = params.runtimeHooks ?? resolveRuntimeHooks();
  const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: normalizedInputModel,
    },
  }) as Model | undefined;
  const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: normalizedInputModel.id,
      model: (pluginNormalized ?? normalizedInputModel) as never,
    },
  }) as Model | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      runtimeHooks,
      model: pluginNormalized ?? normalizedInputModel,
    });
  const normalizedModel = normalizeModelCompat(
    fallbackTransportNormalized ?? pluginNormalized ?? normalizedInputModel,
  ) as Model & ProviderRuntimeModel;
  // Rebuilding provider hooks may drop the host-prepared timeout. Restore it
  // only when the final model does not declare a provider-owned override.
  const modelWithProviderTimeout =
    normalizedModel.requestTimeoutMs === undefined &&
    normalizedInputModel.requestTimeoutMs !== undefined
      ? { ...normalizedModel, requestTimeoutMs: normalizedInputModel.requestTimeoutMs }
      : normalizedModel;
  const providerConfig = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.provider,
  );
  const toolSearchMode =
    runtimeHooks.resolveToolSearchMode?.({
      provider: params.provider,
      modelId: modelWithProviderTimeout.id,
      api: modelWithProviderTimeout.api,
      baseUrl: modelWithProviderTimeout.baseUrl,
    }) ??
    (providerConfig?.localService &&
    modelTransportRoutesMatch(
      { baseUrl: providerConfig.baseUrl },
      { baseUrl: modelWithProviderTimeout.baseUrl },
    )
      ? "tools"
      : undefined);
  // Capture the final route's preference once; tool construction must not reload provider policy.
  const modelWithToolSearch = { ...modelWithProviderTimeout, toolSearchMode };
  return inheritModelProviderRequestRouteFacts(
    params.model,
    canonicalizeLegacyResolvedModel({
      provider: params.provider,
      model: modelWithToolSearch,
    }),
  );
}

export function resolveProviderRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true });
}
