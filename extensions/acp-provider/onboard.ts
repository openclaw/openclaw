import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const ACP_DEFAULT_MODEL_REF = "acp/default";

export function applyAcpProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[ACP_DEFAULT_MODEL_REF] = {
    ...models[ACP_DEFAULT_MODEL_REF],
    alias: models[ACP_DEFAULT_MODEL_REF]?.alias ?? "ACP Agent",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyAcpConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyAcpProviderConfig(cfg), ACP_DEFAULT_MODEL_REF);
}
