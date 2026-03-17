import { OPENCODE_GO_DEFAULT_MODEL_REF } from "openclaw/plugin-sdk/provider-models";
import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export { OPENCODE_GO_DEFAULT_MODEL_REF };

const OPENCODE_GO_ALIAS_DEFAULTS: Record<string, string> = {
  "opencode-go/kimi-k2.5": "Kimi",
  "opencode-go/glm-5": "GLM",
  "opencode-go/minimax-m2.5": "MiniMax",
};

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  for (const [modelRef, alias] of Object.entries(OPENCODE_GO_ALIAS_DEFAULTS)) {
    models[modelRef] = {
      ...models[modelRef],
      alias: models[modelRef]?.alias ?? alias,
    };
  }

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

export function applyOpencodeGoConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpencodeGoProviderConfig(cfg),
    OPENCODE_GO_DEFAULT_MODEL_REF,
  );
}
