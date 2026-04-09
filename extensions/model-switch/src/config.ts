import type { ModelSwitchConfig } from "./types.js";

const DEFAULTS: Omit<ModelSwitchConfig, "models" | "defaultModel"> = {
  skipBootstrapBelowTokens: 2000,
  healthPollIntervalMs: 2000,
  healthTimeoutMs: 120_000,
  switchTimeoutMs: 300_000,
  staleMarkerMaxAgeMs: 600_000,
  maxMarkerRetries: 3,
  contextBridge: {
    strategy: "bootstrap",
    contextWindowBufferRatio: 0.8,
    bootstrap: {
      summaryMaxTokens: 1500,
      preserveRecentTurns: 3,
      preserveRecentMaxTokens: 2000,
      includeSystemPrompt: true,
    },
    compact: {
      targetTokens: 6000,
      preserveRecentTurns: 5,
    },
  },
};

export function resolveConfig(input: unknown): ModelSwitchConfig {
  const raw = (input ?? {}) as Partial<ModelSwitchConfig>;
  const models = raw.models ?? {};
  const modelIds = Object.keys(models);
  const defaultModel = raw.defaultModel ?? modelIds[0] ?? "";
  const rawBridge = (raw.contextBridge ?? {}) as Partial<ModelSwitchConfig["contextBridge"]>;
  const rawBootstrap = (rawBridge.bootstrap ?? {}) as Partial<
    ModelSwitchConfig["contextBridge"]["bootstrap"]
  >;
  const rawCompact = (rawBridge.compact ?? {}) as Partial<
    ModelSwitchConfig["contextBridge"]["compact"]
  >;

  return {
    models,
    defaultModel,
    skipBootstrapBelowTokens: raw.skipBootstrapBelowTokens ?? DEFAULTS.skipBootstrapBelowTokens,
    healthPollIntervalMs: raw.healthPollIntervalMs ?? DEFAULTS.healthPollIntervalMs,
    healthTimeoutMs: raw.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
    switchTimeoutMs: raw.switchTimeoutMs ?? DEFAULTS.switchTimeoutMs,
    staleMarkerMaxAgeMs: raw.staleMarkerMaxAgeMs ?? DEFAULTS.staleMarkerMaxAgeMs,
    maxMarkerRetries: raw.maxMarkerRetries ?? DEFAULTS.maxMarkerRetries,
    contextBridge: {
      strategy: rawBridge.strategy ?? DEFAULTS.contextBridge.strategy,
      contextWindowBufferRatio:
        rawBridge.contextWindowBufferRatio ?? DEFAULTS.contextBridge.contextWindowBufferRatio,
      bootstrap: {
        summaryMaxTokens:
          rawBootstrap.summaryMaxTokens ?? DEFAULTS.contextBridge.bootstrap.summaryMaxTokens,
        preserveRecentTurns:
          rawBootstrap.preserveRecentTurns ?? DEFAULTS.contextBridge.bootstrap.preserveRecentTurns,
        preserveRecentMaxTokens:
          rawBootstrap.preserveRecentMaxTokens ??
          DEFAULTS.contextBridge.bootstrap.preserveRecentMaxTokens,
        includeSystemPrompt:
          rawBootstrap.includeSystemPrompt ?? DEFAULTS.contextBridge.bootstrap.includeSystemPrompt,
      },
      compact: {
        targetTokens: rawCompact.targetTokens ?? DEFAULTS.contextBridge.compact.targetTokens,
        preserveRecentTurns:
          rawCompact.preserveRecentTurns ?? DEFAULTS.contextBridge.compact.preserveRecentTurns,
      },
    },
  };
}
