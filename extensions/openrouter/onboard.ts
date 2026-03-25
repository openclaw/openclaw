import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";

/** Return the currently configured primary model string, if any. */
function resolveExistingPrimary(cfg: OpenClawConfig): string | undefined {
  const model = cfg.agents?.defaults?.model;
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  if (model && typeof model === "object" && "primary" in model) {
    return (model as { primary?: string }).primary?.trim() || undefined;
  }
  return undefined;
}

export function applyOpenrouterProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[OPENROUTER_DEFAULT_MODEL_REF] = {
    ...models[OPENROUTER_DEFAULT_MODEL_REF],
    alias: models[OPENROUTER_DEFAULT_MODEL_REF]?.alias ?? "OpenRouter",
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

export function applyOpenrouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  const providerCfg = applyOpenrouterProviderConfig(cfg);
  // Preserve the user's existing openrouter model selection (e.g. openrouter/free)
  // instead of unconditionally overwriting it with the default openrouter/auto.
  const existing = resolveExistingPrimary(cfg);
  const primary =
    existing && existing.startsWith("openrouter/") ? existing : OPENROUTER_DEFAULT_MODEL_REF;
  return applyAgentDefaultModelPrimary(providerCfg, primary);
}
