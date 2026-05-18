import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
export const TRUSTEDROUTER_DEFAULT_MODEL_REF = "trustedrouter/auto";

function applyDefaultModelAlias(
  cfg: OpenClawConfig,
  modelRef: string,
  alias: string,
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? alias,
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

export function applyOpenrouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyDefaultModelAlias(cfg, OPENROUTER_DEFAULT_MODEL_REF, "OpenRouter");
}

export function applyOpenrouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpenrouterProviderConfig(cfg),
    OPENROUTER_DEFAULT_MODEL_REF,
  );
}

export function applyTrustedRouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyDefaultModelAlias(cfg, TRUSTEDROUTER_DEFAULT_MODEL_REF, "TrustedRouter.com");
}

export function applyTrustedRouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTrustedRouterProviderConfig(cfg),
    TRUSTEDROUTER_DEFAULT_MODEL_REF,
  );
}
