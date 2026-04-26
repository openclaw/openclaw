import { beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resolveProviderDiscoveryFilterForTest } from "./models-config.providers.implicit.js";

function liveFilterEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    VITEST: "1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("resolveProviderDiscoveryFilterForTest", () => {
  beforeEach(() => {
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
        }),
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
        }),
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
        }),
      }),
    ).toEqual(["openrouter"]);
  });
});
