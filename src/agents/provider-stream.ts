/**
 * Provider stream registration entry point.
 * Resolves plugin-owned or transport-aware stream functions and registers the
 * model API once a concrete stream implementation exists.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Api, Model } from "../llm/types.js";
import { resolveProviderStreamFn, wrapProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
} from "./provider-transport-stream.js";
import type { StreamFn } from "./runtime/index.js";

/** Resolves and registers the stream function for a provider-backed model. */
export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
  applyProviderWrapper?: boolean;
}): StreamFn | undefined {
  const transportContext = {
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
  };
  const baseStreamFn =
    resolveProviderStreamFn({
      provider: params.model.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: {
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        provider: params.model.provider,
        modelId: params.model.id,
        model: params.model,
      },
    }) ??
    createTransportAwareStreamFnForModel(params.model, transportContext) ??
    (params.applyProviderWrapper
      ? createBoundaryAwareStreamFnForModel(params.model, transportContext)
      : undefined);
  if (!baseStreamFn) {
    return undefined;
  }
  const streamFn = params.applyProviderWrapper
    ? (wrapProviderStreamFn({
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
          streamFn: baseStreamFn,
        },
      }) ?? baseStreamFn)
    : baseStreamFn;
  // Register custom APIs only after a concrete stream exists, so later callers
  // can route by model.api without reloading provider runtime hooks.
  ensureCustomApiRegistered(params.model.api, streamFn);
  return streamFn;
}
