// Opencode Go setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildStaticOpencodeGoProviderConfig } from "./provider-catalog.js";

export const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.6";
const OPENCODE_GO_DEFAULT_MODEL_ALIAS = "Kimi";

const OPENCODE_GO_STATIC_PROVIDER = buildStaticOpencodeGoProviderConfig();

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, [
      { modelRef: OPENCODE_GO_DEFAULT_MODEL_REF, alias: OPENCODE_GO_DEFAULT_MODEL_ALIAS },
    ]),
    providerId: "opencode-go",
    api: OPENCODE_GO_STATIC_PROVIDER.api!,
    baseUrl: OPENCODE_GO_STATIC_PROVIDER.baseUrl,
    catalogModels: OPENCODE_GO_STATIC_PROVIDER.models,
  });
}

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpencodeGoProviderConfig(cfg),
    OPENCODE_GO_DEFAULT_MODEL_REF,
  );
}
