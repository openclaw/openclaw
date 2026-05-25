import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { normalizeProviderId, findNormalizedProviderValue } from "./provider-id.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";

function resolveConfiguredProvider(params: {
  cfg?: OpenClawConfig;
  provider: string;
}): ModelProviderConfig | undefined {
  return findNormalizedProviderValue(params.cfg?.models?.providers, params.provider);
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
  const googleProviderConfig = resolveConfiguredProvider({ cfg: params.cfg, provider: "google" });
  const configuredApi = normalizeOptionalString(googleProviderConfig?.api);
  if (!configuredApi || configuredApi === "google-generative-ai") {
    return;
  }
  throw new Error(
    `Google model "google/${params.model.id}" cannot use models.providers.google api "${configuredApi}". Expected api "google-generative-ai". Configure the Google provider correctly or remove the mismatched provider config.`,
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
