import type { PluginApi } from "openclaw/plugin-sdk/core";
import type { SmartHandlerConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const VALID_KINDS = new Set([
  "search",
  "install",
  "read",
  "run",
  "write",
  "debug",
  "analyze",
  "chat",
  "unknown",
]);

function validateCustomPhrases(
  value: unknown,
): readonly { readonly phrase: string; readonly kind: import("./types.ts").ExecutionKind }[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CONFIG.customPhrases;
  }
  return value.filter(
    (item): item is { phrase: string; kind: import("./types.ts").ExecutionKind } =>
      typeof item === "object" &&
      item !== null &&
      typeof item.phrase === "string" &&
      item.phrase.length > 0 &&
      typeof item.kind === "string" &&
      VALID_KINDS.has(item.kind),
  );
}

export function getConfig(api: PluginApi): SmartHandlerConfig {
  const pluginConfig = api.config.plugins?.entries?.["smart-message-handler"]?.config || {};
  const merged = { ...DEFAULT_CONFIG, ...pluginConfig };

  // Runtime type guards — fall back to defaults for invalid values
  return {
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
    incompleteSignals: Array.isArray(merged.incompleteSignals)
      ? merged.incompleteSignals
      : DEFAULT_CONFIG.incompleteSignals,
    completeSignals: Array.isArray(merged.completeSignals)
      ? merged.completeSignals
      : DEFAULT_CONFIG.completeSignals,
    baseDebounceMultiplier:
      typeof merged.baseDebounceMultiplier === "number"
        ? merged.baseDebounceMultiplier
        : DEFAULT_CONFIG.baseDebounceMultiplier,
    maxDebounceMultiplier:
      typeof merged.maxDebounceMultiplier === "number"
        ? merged.maxDebounceMultiplier
        : DEFAULT_CONFIG.maxDebounceMultiplier,
    minMessageLength:
      typeof merged.minMessageLength === "number"
        ? merged.minMessageLength
        : DEFAULT_CONFIG.minMessageLength,
    debug: typeof merged.debug === "boolean" ? merged.debug : DEFAULT_CONFIG.debug,
    executionSignalEnabled:
      typeof merged.executionSignalEnabled === "boolean"
        ? merged.executionSignalEnabled
        : DEFAULT_CONFIG.executionSignalEnabled,
    disableForLocalMainSession:
      typeof merged.disableForLocalMainSession === "boolean"
        ? merged.disableForLocalMainSession
        : DEFAULT_CONFIG.disableForLocalMainSession,
    shadowModeEnabled:
      typeof merged.shadowModeEnabled === "boolean"
        ? merged.shadowModeEnabled
        : DEFAULT_CONFIG.shadowModeEnabled,
    customPhrases: validateCustomPhrases(merged.customPhrases),
    embeddingCacheEnabled:
      typeof merged.embeddingCacheEnabled === "boolean"
        ? merged.embeddingCacheEnabled
        : DEFAULT_CONFIG.embeddingCacheEnabled,
    embeddingCachePath:
      typeof merged.embeddingCachePath === "string"
        ? merged.embeddingCachePath
        : DEFAULT_CONFIG.embeddingCachePath,
    locale:
      typeof merged.locale === "string" && (merged.locale === "zh-CN" || merged.locale === "en")
        ? merged.locale
        : DEFAULT_CONFIG.locale,
    scoreThreshold:
      typeof merged.scoreThreshold === "number"
        ? merged.scoreThreshold
        : DEFAULT_CONFIG.scoreThreshold,
    modelRoutingEnabled:
      typeof merged.modelRoutingEnabled === "boolean"
        ? merged.modelRoutingEnabled
        : DEFAULT_CONFIG.modelRoutingEnabled,
    fastModel: typeof merged.fastModel === "string" ? merged.fastModel : DEFAULT_CONFIG.fastModel,
    premiumModel:
      typeof merged.premiumModel === "string" ? merged.premiumModel : DEFAULT_CONFIG.premiumModel,
  };
}
