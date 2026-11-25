import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api } from "../../llm/types.js";
import { normalizeProviderTransportWithPlugin } from "../../plugins/provider-runtime.js";
import { normalizeResolvedTransportApi } from "./model.inline-provider.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.types.js";

export function resolveProviderTransport(params: {
  provider: string;
  modelId?: string;
  api?: Api | null;
  baseUrl?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { api?: Api; baseUrl?: string } {
  const runtimeHooks = params.runtimeHooks ?? { normalizeProviderTransportWithPlugin };
  const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
    provider: params.provider,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      ...(params.modelId ? { modelId: params.modelId } : {}),
      api: params.api,
      baseUrl: params.baseUrl,
    },
  });
  return {
    api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
    baseUrl: normalized?.baseUrl ?? params.baseUrl,
  };
}
