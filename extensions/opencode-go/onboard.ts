import {
  applyAgentDefaultModelPrimary,
  withAgentModelAliases,
  type MullusiConfig,
} from "mullusi/plugin-sdk/provider-onboard";

export const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";

const OPENCODE_GO_ALIAS_DEFAULTS: Record<string, string> = {
  "opencode-go/kimi-k2.5": "Kimi",
  "opencode-go/glm-5": "GLM",
  "opencode-go/minimax-m2.5": "MiniMax",
};

export function applyOpencodeGoProviderConfig(cfg: MullusiConfig): MullusiConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: withAgentModelAliases(
          cfg.agents?.defaults?.models,
          Object.entries(OPENCODE_GO_ALIAS_DEFAULTS).map(([modelRef, alias]) => ({
            modelRef,
            alias,
          })),
        ),
      },
    },
  };
}

export function applyOpencodeGoConfig(cfg: MullusiConfig): MullusiConfig {
  return applyAgentDefaultModelPrimary(
    applyOpencodeGoProviderConfig(cfg),
    OPENCODE_GO_DEFAULT_MODEL_REF,
  );
}
