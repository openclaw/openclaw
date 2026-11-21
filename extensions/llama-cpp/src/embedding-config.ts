import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LEGACY_LLAMA_CPP_EMBEDDING_MODEL, resolveLlamaCppPresetPath } from "./defaults.js";

type MemorySearch = NonNullable<NonNullable<OpenClawConfig["memory"]>["search"]>;

export function usesLocalEmbeddings(search?: MemorySearch, defaults?: MemorySearch): boolean {
  const provider = normalizeOptionalLowercaseString(search?.provider ?? defaults?.provider);
  return (
    provider === "local" ||
    (provider !== "none" &&
      normalizeOptionalLowercaseString(search?.fallback ?? defaults?.fallback) === "local")
  );
}

export function preserveLlamaCppEmbeddingModel(cfg: OpenClawConfig): OpenClawConfig {
  // New setup saves its selection. An existing preset service without one used
  // the legacy default; direct-model services must identify their actual model.
  return resolveLlamaCppPresetPath(cfg.models?.providers?.["llama-cpp"]?.localService)
    ? pinImplicitLlamaCppEmbeddingModel(cfg, LEGACY_LLAMA_CPP_EMBEDDING_MODEL.source)
    : cfg;
}

/** Publish the implicit selection once; runtime continues to read ordinary modelPath. */
export function pinImplicitLlamaCppEmbeddingModel(
  cfg: OpenClawConfig,
  modelPath: string,
  initializeDefault = false,
): OpenClawConfig {
  const defaults = cfg.memory?.search;
  let next = cfg;
  if ((initializeDefault || usesLocalEmbeddings(defaults)) && !defaults?.local?.modelPath?.trim()) {
    next = {
      ...next,
      memory: {
        ...cfg.memory,
        search: {
          ...defaults,
          local: { ...defaults?.local, modelPath },
        },
      },
    };
  }
  for (const [id, agent] of Object.entries(cfg.agents?.entries ?? {})) {
    const search = agent.memory?.search;
    // Resolve against the original defaults. An authored blank suppresses an
    // inherited explicit path and must not silently adopt that parent's model.
    const selected = search?.local?.modelPath ?? defaults?.local?.modelPath;
    if (!usesLocalEmbeddings(search, defaults) || selected?.trim()) {
      continue;
    }
    if (search?.local?.modelPath === undefined && next.memory?.search?.local?.modelPath?.trim()) {
      continue;
    }
    next = {
      ...next,
      agents: {
        ...next.agents,
        entries: {
          ...next.agents?.entries,
          [id]: {
            ...agent,
            memory: {
              ...agent.memory,
              search: {
                ...search,
                local: { ...search?.local, modelPath },
              },
            },
          },
        },
      },
    };
  }
  return next;
}
