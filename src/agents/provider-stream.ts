import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";
import { configureModelWorkerPool } from "./model-worker-pool.js";

/** Lazy init guard: configure worker pool once per config. */
let workerPoolConfigured = false;

function maybeConfigureModelWorkerPool(cfg?: OpenClawConfig): void {
  if (workerPoolConfigured) return;
  const poolConfig = cfg?.gateway?.modelWorkerPool;
  if (poolConfig) {
    configureModelWorkerPool(poolConfig);
    workerPoolConfigured = true;
  }
}

export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
}): StreamFn | undefined {
  // Initialize model worker pool from gateway config (lazy, once-per-process)
  maybeConfigureModelWorkerPool(params.cfg);

  const streamFn =
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
    createTransportAwareStreamFnForModel(params.model, {
      cfg: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  if (!streamFn) {
    return undefined;
  }
  ensureCustomApiRegistered(params.model.api, streamFn);
  return streamFn;
}
