import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { shouldExcludeProviderFromDefaultHighSignalLiveSweep } from "./live-model-filter.js";

function hermeticProviderRegistryEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    VITEST: "1",
  } as NodeJS.ProcessEnv;
}

describe("shouldExcludeProviderFromDefaultHighSignalLiveSweep", () => {
  beforeEach(() => {
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("excludes dedicated harness providers from the default high-signal sweep", () => {
    const env = hermeticProviderRegistryEnv();

    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: null,
        env,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: null,
        env,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex-cli",
        useExplicitModels: false,
        providerFilter: null,
        env,
      }),
    ).toBe(true);
  });

  it("keeps dedicated harness providers when explicitly requested by provider filter", () => {
    const env = hermeticProviderRegistryEnv();

    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex"]),
        env,
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex-cli"]),
        env,
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: new Set(["openai"]),
        env,
      }),
    ).toBe(false);
  });

  it("keeps dedicated harness providers when the caller uses explicit model selection", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: true,
        providerFilter: null,
      }),
    ).toBe(false);
  });

  it("does not exclude ordinary providers", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
        env: hermeticProviderRegistryEnv(),
      }),
    ).toBe(false);
  });
});
