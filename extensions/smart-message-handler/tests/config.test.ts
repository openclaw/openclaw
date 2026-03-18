import { describe, it, expect } from "vitest";
import { getConfig } from "../src/config.ts";
import type { SmartHandlerConfig } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Minimal PluginApi mock
// ---------------------------------------------------------------------------
// config.ts only accesses: api.config.plugins?.entries?.[key]?.config
// We model just that slice of the interface.

type PluginConfigMap = Record<string, { config?: Record<string, unknown> }>;

function makeApi(pluginEntries: PluginConfigMap = {}): {
  config: { plugins: { entries: PluginConfigMap } };
} {
  return {
    config: {
      plugins: {
        entries: pluginEntries,
      },
    },
  };
}

function makeApiNoPlugins(): { config: Record<string, unknown> } {
  return { config: {} };
}

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

describe("getConfig", () => {
  it("returns DEFAULT_CONFIG when no plugin config entry exists", () => {
    const api = makeApi({}) as never;
    const result = getConfig(api);
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("returns DEFAULT_CONFIG when plugins key is absent", () => {
    const api = makeApiNoPlugins() as never;
    const result = getConfig(api);
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it("merges user config on top of DEFAULT_CONFIG", () => {
    const api = makeApi({
      "smart-message-handler": {
        config: { debug: true, maxDebounceMultiplier: 5 },
      },
    }) as never;
    const result = getConfig(api);
    expect(result.debug).toBe(true);
    expect(result.maxDebounceMultiplier).toBe(5);
    // Unchanged defaults should remain
    expect(result.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(result.baseDebounceMultiplier).toBe(DEFAULT_CONFIG.baseDebounceMultiplier);
  });

  it("user config value false overrides DEFAULT_CONFIG truthy value", () => {
    const api = makeApi({
      "smart-message-handler": {
        config: { enabled: false },
      },
    }) as never;
    const result = getConfig(api);
    expect(result.enabled).toBe(false);
  });

  it("falls back to default when enabled is a non-boolean value", () => {
    const api = makeApi({
      "smart-message-handler": { config: { enabled: "yes" } },
    }) as never;
    const result = getConfig(api);
    expect(result.enabled).toBe(DEFAULT_CONFIG.enabled);
  });

  it("falls back to default when incompleteSignals is not an array", () => {
    const api = makeApi({
      "smart-message-handler": { config: { incompleteSignals: 42 } },
    }) as never;
    const result = getConfig(api);
    expect(result.incompleteSignals).toEqual(DEFAULT_CONFIG.incompleteSignals);
  });

  it("falls back to default when baseDebounceMultiplier is not a number", () => {
    const api = makeApi({
      "smart-message-handler": { config: { baseDebounceMultiplier: "fast" } },
    }) as never;
    const result = getConfig(api);
    expect(result.baseDebounceMultiplier).toBe(DEFAULT_CONFIG.baseDebounceMultiplier);
  });

  it("returns a SmartHandlerConfig shaped object (has all required keys)", () => {
    const api = makeApi({}) as never;
    const result = getConfig(api);
    const requiredKeys: (keyof SmartHandlerConfig)[] = [
      "enabled",
      "incompleteSignals",
      "completeSignals",
      "baseDebounceMultiplier",
      "maxDebounceMultiplier",
      "minMessageLength",
      "debug",
      "executionSignalEnabled",
      "disableForLocalMainSession",
      "shadowModeEnabled",
      "locale",
      "modelRoutingEnabled",
      "fastModel",
      "premiumModel",
    ];
    for (const key of requiredKeys) {
      expect(key in result).toBe(true);
    }
  });

  it("accepts 'en' as a valid locale", () => {
    const api = makeApi({
      "smart-message-handler": { config: { locale: "en" } },
    }) as never;
    const result = getConfig(api);
    expect(result.locale).toBe("en");
  });

  it("accepts 'zh-CN' as a valid locale", () => {
    const api = makeApi({
      "smart-message-handler": { config: { locale: "zh-CN" } },
    }) as never;
    const result = getConfig(api);
    expect(result.locale).toBe("zh-CN");
  });

  it("falls back to default locale for invalid locale string", () => {
    const api = makeApi({
      "smart-message-handler": { config: { locale: "fr" } },
    }) as never;
    const result = getConfig(api);
    expect(result.locale).toBe(DEFAULT_CONFIG.locale);
  });

  it("falls back to default locale for non-string locale", () => {
    const api = makeApi({
      "smart-message-handler": { config: { locale: 42 } },
    }) as never;
    const result = getConfig(api);
    expect(result.locale).toBe(DEFAULT_CONFIG.locale);
  });

  it("defaults modelRoutingEnabled to false", () => {
    const api = makeApi({}) as never;
    const result = getConfig(api);
    expect(result.modelRoutingEnabled).toBe(false);
  });

  it("accepts modelRoutingEnabled as boolean", () => {
    const api = makeApi({
      "smart-message-handler": { config: { modelRoutingEnabled: true } },
    }) as never;
    const result = getConfig(api);
    expect(result.modelRoutingEnabled).toBe(true);
  });

  it("falls back to default when modelRoutingEnabled is non-boolean", () => {
    const api = makeApi({
      "smart-message-handler": { config: { modelRoutingEnabled: "yes" } },
    }) as never;
    const result = getConfig(api);
    expect(result.modelRoutingEnabled).toBe(DEFAULT_CONFIG.modelRoutingEnabled);
  });

  it("defaults fastModel to empty string", () => {
    const api = makeApi({}) as never;
    const result = getConfig(api);
    expect(result.fastModel).toBe("");
  });

  it("accepts fastModel as string", () => {
    const api = makeApi({
      "smart-message-handler": { config: { fastModel: "claude-haiku-4" } },
    }) as never;
    const result = getConfig(api);
    expect(result.fastModel).toBe("claude-haiku-4");
  });

  it("falls back to default when fastModel is non-string", () => {
    const api = makeApi({
      "smart-message-handler": { config: { fastModel: 42 } },
    }) as never;
    const result = getConfig(api);
    expect(result.fastModel).toBe(DEFAULT_CONFIG.fastModel);
  });

  it("defaults premiumModel to empty string", () => {
    const api = makeApi({}) as never;
    const result = getConfig(api);
    expect(result.premiumModel).toBe("");
  });

  it("accepts premiumModel as string", () => {
    const api = makeApi({
      "smart-message-handler": { config: { premiumModel: "claude-opus-4" } },
    }) as never;
    const result = getConfig(api);
    expect(result.premiumModel).toBe("claude-opus-4");
  });
});
