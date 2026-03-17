import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../../src/agents/opencode-zen-models.js";
import { applyAgentDefaultModelPrimary } from "../../src/commands/onboard-auth.config-shared.js";
import type { OpenClawConfig } from "../../src/config/config.js";

export { OPENCODE_ZEN_DEFAULT_MODEL_REF };

export function applyOpencodeZenProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
    ...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
    alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus",
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

export function applyOpencodeZenConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyOpencodeZenProviderConfig(cfg),
    OPENCODE_ZEN_DEFAULT_MODEL_REF,
  );
}
