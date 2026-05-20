export type ModelRouterConfig = {
  default?: string;
  fast?: string;
  embed?: string;
};

export type ModelRouter = {
  resolve(stepKind: string, explicitModel?: string): string | undefined;
};

/**
 * Resolves LLM model for playbook steps. Explicit step.model always wins.
 */
export function createModelRouter(config?: ModelRouterConfig): ModelRouter {
  const defaults = {
    default: config?.default ?? "sonnet-4.6",
    fast: config?.fast ?? config?.default ?? "sonnet-4.6",
    embed: config?.embed,
  };

  return {
    resolve(stepKind, explicitModel) {
      if (explicitModel?.trim()) {
        return explicitModel.trim();
      }
      switch (stepKind) {
        case "llm":
        case "function":
          return defaults.default;
        case "subagent":
          return defaults.default;
        default:
          return undefined;
      }
    },
  };
}
