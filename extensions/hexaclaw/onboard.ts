import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildHexaclawProvider, HEXACLAW_BASE_URL } from "./provider-catalog.js";

export const HEXACLAW_DEFAULT_MODEL_REF = "hexaclaw/claude-sonnet-4-6";

export function applyHexaclawProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[HEXACLAW_DEFAULT_MODEL_REF] = {
    ...models[HEXACLAW_DEFAULT_MODEL_REF],
    alias: models[HEXACLAW_DEFAULT_MODEL_REF]?.alias ?? "HexaClaw",
  };

  const provider = buildHexaclawProvider();
  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "hexaclaw",
    api: "openai-completions",
    baseUrl: HEXACLAW_BASE_URL,
    catalogModels: provider.models,
  });
}

export function applyHexaclawConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyHexaclawProviderConfig(cfg),
    HEXACLAW_DEFAULT_MODEL_REF,
  );
}
