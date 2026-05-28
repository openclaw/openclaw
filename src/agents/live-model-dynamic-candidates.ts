import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import {
  prepareProviderDynamicModel,
  runProviderDynamicModel,
} from "../plugins/provider-runtime.js";
import type { ProviderResolveDynamicModelContext } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeDiscoveredAgentModel } from "./agent-model-discovery.js";
import { listPrioritizedHighSignalLiveModelRefs } from "./live-model-filter.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

type DynamicModelResolver = typeof runProviderDynamicModel;
type DynamicModelPreparer = typeof prepareProviderDynamicModel;

function liveModelKey(provider: string, id: string): string | null {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return normalizedProvider && normalizedId ? `${normalizedProvider}/${normalizedId}` : null;
}

export async function appendPrioritizedDynamicLiveModels(params: {
  models: Model[];
  config?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelRegistry: ProviderResolveDynamicModelContext["modelRegistry"];
  resolveDynamicModel?: DynamicModelResolver;
  prepareDynamicModel?: DynamicModelPreparer;
  refs?: Array<{ provider: string; id: string }>;
}): Promise<{ models: Model[]; added: Model[] }> {
  const resolveDynamicModel = params.resolveDynamicModel ?? runProviderDynamicModel;
  const prepareDynamicModel = params.prepareDynamicModel ?? prepareProviderDynamicModel;
  const refs = params.refs ?? listPrioritizedHighSignalLiveModelRefs();
  const seen = new Set<string>();
  for (const model of params.models) {
    const key = liveModelKey(model.provider, model.id);
    if (key) {
      seen.add(key);
    }
  }

  const models = [...params.models];
  const added: Model[] = [];
  for (const ref of refs) {
    const requestedKey = liveModelKey(ref.provider, ref.id);
    if (!requestedKey || seen.has(requestedKey)) {
      continue;
    }
    const providerConfig = findNormalizedProviderValue(
      params.config?.models?.providers,
      ref.provider,
    );
    const context = {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: ref.provider,
      modelId: ref.id,
      modelRegistry: params.modelRegistry,
      providerConfig,
    };
    await prepareDynamicModel({
      provider: ref.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      context,
    });
    const resolved = resolveDynamicModel({
      provider: ref.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      context,
    });
    if (!resolved) {
      continue;
    }
    const model = normalizeDiscoveredAgentModel(resolved as Model, params.agentDir);
    const resolvedKey = liveModelKey(model.provider, model.id);
    if (!resolvedKey || seen.has(resolvedKey)) {
      continue;
    }
    seen.add(resolvedKey);
    models.push(model);
    added.push(model);
  }
  return { models, added };
}
