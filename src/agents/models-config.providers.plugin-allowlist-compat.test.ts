import { describe, expect, it } from "vitest";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "../plugins/bundled-compat.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginRegistrySnapshot } from "../plugins/plugin-registry.js";
import { resolveEnabledProviderPluginIds } from "../plugins/providers.js";

const TEST_ENV = {
  VITEST: "1",
} as NodeJS.ProcessEnv;

const PLUGIN_IDS = ["kilocode", "moonshot", "openrouter"] as const;

const TEST_REGISTRY: PluginRegistrySnapshot = {
  version: 1,
  hostContractVersion: "test",
  compatRegistryVersion: "test",
  migrationVersion: 1,
  policyHash: "test",
  generatedAtMs: 0,
  installRecords: {},
  plugins: PLUGIN_IDS.map((pluginId) => ({
    pluginId,
    manifestPath: `/tmp/openclaw-test/${pluginId}/openclaw.plugin.json`,
    manifestHash: `${pluginId}-hash`,
    rootDir: `/tmp/openclaw-test/${pluginId}`,
    origin: "bundled",
    enabled: true,
    enabledByDefault: true,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  })),
  diagnostics: [],
};

const TEST_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: PLUGIN_IDS.map((pluginId) => ({
    id: pluginId,
    origin: "bundled",
    manifestPath: `/tmp/openclaw-test/${pluginId}/openclaw.plugin.json`,
    source: `/tmp/openclaw-test/${pluginId}/index.ts`,
    rootDir: `/tmp/openclaw-test/${pluginId}`,
    channels: [],
    providers: [pluginId],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: {},
  })),
  diagnostics: [],
};

describe("implicit provider plugin allowlist compatibility", () => {
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
        env: TEST_ENV,
        onlyPluginIds: [...PLUGIN_IDS],
        registry: TEST_REGISTRY,
        manifestRegistry: TEST_MANIFEST_REGISTRY,
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
        env: TEST_ENV,
        onlyPluginIds: [...PLUGIN_IDS],
        registry: TEST_REGISTRY,
        manifestRegistry: TEST_MANIFEST_REGISTRY,
      }),
    ).toEqual(["moonshot", "openrouter"]);
  });
});
