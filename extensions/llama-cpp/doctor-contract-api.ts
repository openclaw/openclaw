import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLlamaCppDataDir } from "./src/defaults.js";
import { findManagedLlamaServerAsset, LLAMA_SERVER_RELEASE } from "./src/llama-server-assets.js";

function resolveRuntimeUpgrade(command: unknown): string | undefined {
  if (typeof command !== "string") {
    return undefined;
  }
  const root = resolveLlamaCppDataDir();
  const installation = path.basename(path.dirname(command));
  const executable = path.basename(command);
  // Only the exact shipped installation belongs to this migration. Custom
  // commands, other state roots, and other hosts retain their operator owner.
  if (command !== path.join(root, "b10809", installation, executable)) {
    return undefined;
  }
  const replacement = path.join(root, LLAMA_SERVER_RELEASE, installation, executable);
  return replacement !== command && findManagedLlamaServerAsset(replacement)
    ? replacement
    : undefined;
}

export const legacyConfigRules = [
  {
    path: ["models", "providers", "llama-cpp", "localService", "command"],
    message:
      'The managed llama.cpp runtime predates EmbeddingGemma 2. Run "openclaw doctor --fix" to select the current verified runtime, then rebuild affected memory indexes.',
    match: (value: unknown) => resolveRuntimeUpgrade(value) !== undefined,
  },
];

/** Doctor owns config publication; normal managed preparation installs the new runtime. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const provider = cfg.models?.providers?.["llama-cpp"];
  const command = resolveRuntimeUpgrade(provider?.localService?.command);
  if (!provider?.localService || !command) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models?.providers,
          "llama-cpp": {
            ...provider,
            localService: { ...provider.localService, command },
          },
        },
      },
    },
    changes: [
      `Selected the verified llama.cpp ${LLAMA_SERVER_RELEASE} runtime; managed preparation installs it when needed. Explicit embedding models and service settings are unchanged. Rebuild memory indexes that used the previous default embedding model.`,
    ],
  };
}
