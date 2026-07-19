import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildMinimaxPortalProvider } from "./provider-catalog.js";

export function migrateLegacyMinimaxPortalModels(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.["minimax-portal"];
  if (!provider || !Array.isArray(provider.models) || provider.models.length !== 0) {
    return null;
  }

  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: {
          ...config.models?.providers,
          "minimax-portal": {
            ...provider,
            models: buildMinimaxPortalProvider().models,
          },
        },
      },
    },
    changes: ["restored the MiniMax OAuth model catalog for a legacy empty provider entry"],
  };
}
