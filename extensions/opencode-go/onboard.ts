import {
  applyAgentDefaultModelPrimary,
  withAgentModelAliases,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";

const OPENCODE_GO_ALIAS_DEFAULTS: Record<string, string> = {
  "opencode-go/kimi-k2.5": "Kimi",
  "opencode-go/glm-5": "GLM 5",
  "opencode-go/glm-5.1": "GLM",
  "opencode-go/minimax-m2.5": "MiniMax",
};

function migrateLegacyAliasToLatest(params: {
  models: Record<string, { alias?: string }>;
  previousModelRef: string;
  previousVersionedAlias: string;
  latestModelRef: string;
  latestAlias: string;
}): Record<string, { alias?: string }> {
  const previous = params.models[params.previousModelRef];
  if (previous?.alias !== params.latestAlias) {
    return params.models;
  }

  return {
    ...params.models,
    [params.previousModelRef]: {
      ...previous,
      alias: params.previousVersionedAlias,
    },
    [params.latestModelRef]: {
      ...params.models[params.latestModelRef],
      alias: params.models[params.latestModelRef]?.alias ?? params.latestAlias,
    },
  };
}

export function applyOpencodeGoProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = migrateLegacyAliasToLatest({
    models: withAgentModelAliases(
      cfg.agents?.defaults?.models,
      Object.entries(OPENCODE_GO_ALIAS_DEFAULTS).map(([modelRef, alias]) => ({
        modelRef,
        alias,
      })),
    ),
    previousModelRef: "opencode-go/glm-5",
    previousVersionedAlias: "GLM 5",
    latestModelRef: "opencode-go/glm-5.1",
    latestAlias: "GLM",
  });

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
