import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
} from "./provider-transport-stream.js";

export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): StreamFn | undefined {
  const providerStreamFn = resolveProviderStreamFn({
    provider: params.model.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.model.provider,
      modelId: params.model.id,
      model: params.model,
    },
  });
  const registryStreamFn =
    (params.model.api === "ollama" ? createBoundaryAwareStreamFnForModel(params.model) : undefined) ??
    providerStreamFn ??
    createTransportAwareStreamFnForModel(params.model);
  if (!registryStreamFn) {
    return undefined;
  }
  ensureCustomApiRegistered(params.model.api, registryStreamFn);
  return providerStreamFn ?? registryStreamFn;
}
