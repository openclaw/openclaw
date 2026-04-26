import { beforeEach, describe, expect, it } from "vitest";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "../plugins/bundled-compat.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resolveEnabledProviderPluginIds } from "../plugins/providers.js";

function providerRegistryEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    VITEST: "1",
  } as NodeJS.ProcessEnv;
}

describe("implicit provider plugin allowlist compatibility", () => {
  beforeEach(() => {
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("keeps bundled implicit providers discoverable when plugins.allow is set", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        env: providerRegistryEnv(),
        onlyPluginIds: ["kilocode", "moonshot", "openrouter"],
      }),
    ).toEqual(["kilocode", "moonshot", "openrouter"]);
  });

  it("still honors explicit plugin denies over compat allowlist injection", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
            deny: ["kilocode"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        env: providerRegistryEnv(),
        onlyPluginIds: ["kilocode", "moonshot", "openrouter"],
      }),
    ).toEqual(["moonshot", "openrouter"]);
  });
});
