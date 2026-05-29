import { loadPluginManifestRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveCatalogHookProviderPluginIds } from "openclaw/plugin-sdk/provider-catalog-runtime";
import { describe, expect, it } from "vitest";

describe("opencode catalog real pipeline proof", () => {
  it("manifest declares runtimeAugment and is picked up by real loader", () => {
    const registry = loadPluginManifestRegistry({});
    const opencodePlugin = registry.plugins.find(
      (p) => p.origin === "bundled" && p.id === "opencode",
    );
    expect(opencodePlugin).toBeDefined();
    expect(opencodePlugin?.modelCatalog?.runtimeAugment).toBe(true);
  });

  it("resolveCatalogHookProviderPluginIds includes opencode", () => {
    const result = resolveCatalogHookProviderPluginIds({
      config: {},
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toContain("opencode");
  });
});
