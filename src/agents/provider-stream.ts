import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { normalizeProviderId, findNormalizedProviderValue } from "./provider-id.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";

function hasConfiguredProvider(params: { cfg?: OpenClawConfig; provider: string }): boolean {
  return Boolean(findNormalizedProviderValue(params.cfg?.models?.providers, params.provider));
}

function isGoogleGenerativeModel<TApi extends Api>(model: Model<TApi>): boolean {
  return model.api === "google-generative-ai" && normalizeProviderId(model.provider) === "google";
}

function assertProviderConfigMatchesModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): void {
  if (!isGoogleGenerativeModel(params.model)) {
    return;
  }
  if (hasConfiguredProvider({ cfg: params.cfg, provider: "google" })) {
    return;
  }
  throw new Error(
    `Google model "google/${params.model.id}" requires models.providers.google. Configure the Google provider or remove this model from the primary/fallback model list.`,
  );
}

export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowRuntimePluginLoad?: boolean;
}): StreamFn | undefined {
  assertProviderConfigMatchesModel({ model: params.model, cfg: params.cfg });

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
