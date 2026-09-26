import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginActivationConfig } from "../gateway/plugin-activation-runtime-config.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  bindPluginRegistryGatewayOwner,
  getPluginRegistryGatewayOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances, getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createPreparedInboundRegistryLoader,
  prepareWorkspacePluginRegistries,
} from "./prepared-model-runtime.inbound-registry.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  "configured provider",
  "bundled configured provider",
  "synchronous preparation",
  "changed registration config",
  "changed environment",
  "explicit environment",
  "changed workspace",
  "new metadata generation",
  "no Gateway binding",
  "model catalog",
  "new selection",
] as const)("prepares startup owners without unsafe recapture or reuse: %s", async (scenario) => {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
  const event = `startup-selection:${workspaceDir}`;
  const registrations: Array<{ id: string; directory: string }> = [];
  const onCapture = (id: string, directory: string) => registrations.push({ id, directory });
  process.on(event, onCapture);
  using _ = { [Symbol.dispose]: () => process.off(event, onCapture) };
  const bundled = scenario === "bundled configured provider";
  const bundledDir = makePluginLoaderTempDir();
  if (bundled) {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  }
  const plugins = ["existing-external", "selected-provider", "unused-provider"].map((id) => {
    const plugin = writePlugin({
      id,
      ...(bundled && id === "selected-provider" ? { dir: bundledDir } : {}),
      configSchema: { type: "object", properties: { label: { type: "string" } } },
      registration: `process.emit(${JSON.stringify(event)}, ${JSON.stringify(id)}, __dirname);
        api.registerProvider({ id: ${JSON.stringify(id)}, label: api.pluginConfig.label, auth: [] });`,
    });
    const manifestFile = path.join(plugin.dir, "openclaw.plugin.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestFile, "utf8")),
        providers: [id],
        activation: {
          onStartup: id === "existing-external" || (bundled && id === "selected-provider"),
        },
        ...(bundled && id === "selected-provider" ? { enabledByDefault: true } : {}),
      }),
    );
    return plugin;
  });
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: scenario === "new selection" ? "custom/model" : "selected-provider/model",
        models: { "unused-provider/model": { alias: "unused" } },
      },
    },
    models: {
      providers: {
        "selected-provider": {
          baseUrl: "https://provider.invalid/v1",
          api: "openai-responses",
          models: [],
        },
      },
    },
    plugins: {
      allow: plugins.map(({ id }) => id),
      load: {
        paths: plugins
          .filter(({ id }) => !bundled || id !== "selected-provider")
          .map(({ file }) => file),
      },
      entries: Object.fromEntries(
        plugins.map(({ id }) => [
          id,
          {
            ...(bundled && id === "selected-provider" ? {} : { enabled: true }),
            config: { label: "startup" },
          },
        ]),
      ),
      slots: { memory: "none" },
    },
  };
  const input: PreparedModelRuntimeInput = {
    config,
    workspaceDir,
    agentDir: workspaceDir,
    allowGatewaySubagentBinding: true,
    runtimePluginSelections: [
      { provider: "selected-provider", modelId: "model", runtime: "openclaw" },
    ],
  };
  await using cache = createPluginCache();
  await using metadataCache = createPluginCache();
  await withPluginCache(cache, async () => {
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
    const startupConfig = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: config,
      activationSourceConfig: config,
      env: process.env,
      manifestRegistry: metadata.manifestRegistry,
      discovery: metadata.discovery,
    });
    input.config = startupConfig;

    if (bundled) {
      expect(metadata.byPluginId.get("selected-provider")?.origin).toBe("bundled");
      expect(config.plugins?.entries?.["selected-provider"]?.enabled).toBeUndefined();
      expect(startupConfig.plugins?.entries?.["selected-provider"]?.enabled).toBe(true);
    }
    const lookup = loadPluginLookUpTable({
      config: startupConfig,
      activationSourceConfig: config,
      workspaceDir,
      env: process.env,
      metadataSnapshot: metadata,
    });
    const loaded = loadGatewayPlugins({
      cfg: startupConfig,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir,
      pluginLookUpTable: lookup,
      pluginMetadataSnapshot: metadata,
      baseMethods: [],
      loadIntent: "startup",
      channelPluginLoadIntent: "full",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const root = loaded.pluginRegistry;
    const startupRegistrations = [...registrations];
    activatePluginRegistry(root, null, "gateway-bindable", workspaceDir);
    const gatewayOwner = { current: () => root };
    bindPluginRegistryGatewayOwner(root, gatewayOwner);
    if (scenario === "changed registration config") {
      input.config = structuredClone(startupConfig);
      input.config.plugins!.entries!["existing-external"]!.config = { label: "changed" };
    } else if (scenario === "changed environment") {
      vi.stubEnv("OPENCLAW_STARTUP_CAPTURE_CONTEXT", "changed");
    } else if (scenario === "explicit environment") {
      input.env = { ...process.env };
    } else if (scenario === "changed workspace") {
      input.workspaceDir = makePluginLoaderTempDir();
    } else if (scenario === "no Gateway binding") {
      input.allowGatewaySubagentBinding = false;
    }
    const selectedMetadata =
      scenario === "new metadata generation" || scenario === "changed workspace"
        ? withPluginCache(metadataCache, () =>
            loadPluginMetadataSnapshot({
              config: input.config,
              workspaceDir: input.workspaceDir,
              allowCurrent: false,
            }),
          )
        : metadata;
    const catalog = scenario === "model catalog";
    const compatible =
      scenario === "configured provider" ||
      scenario === "bundled configured provider" ||
      scenario === "synchronous preparation" ||
      scenario === "new selection";
    const reuses = compatible && scenario !== "new selection";
    const resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    const loadInbound = createPreparedInboundRegistryLoader();
    let selected: PluginRegistry | undefined;
    try {
      expect(root.plugins).toContainEqual(
        expect.objectContaining({ id: "existing-external", status: "loaded" }),
      );
      const prepared = await withPluginRuntimeRegistryScope(root, () =>
        prepareWorkspacePluginRegistries(
          input,
          selectedMetadata,
          (registry) => resources.retainRegistry(registry),
          loadInbound,
          true,
          undefined,
          () => [],
          undefined,
          scenario === "synchronous preparation" ? undefined : resources.load.bind(resources),
          catalog ? "model-catalog" : "agent",
        ),
      );
      selected = prepared.runtimePluginRegistry;
      // Actual startup selection and publication carry the context; no mocked reuse predicate
      // or hand-admitted all-loaded base can hide the old nonempty A -> A+B recapture.
      expect(prepared.inboundPluginRegistry === root).toBe(compatible);
      expect(selected?.providers.map(({ provider }) => provider.id).toSorted()).toEqual(
        catalog ? [] : ["existing-external", "selected-provider"],
      );
      expect(registrations.filter(({ id }) => id === "existing-external")).toHaveLength(
        reuses || catalog ? 1 : 2,
      );
      expect(registrations.filter(({ id }) => id === "selected-provider")).toHaveLength(
        reuses || catalog || scenario === "new selection" ? 1 : 2,
      );
      expect(selected === root).toBe(reuses);
      expect(prepared.primaryRegistry === root).toBe(reuses);
      expect(lookup.startup.pluginIds.toSorted()).toEqual(
        scenario === "new selection"
          ? ["existing-external"]
          : ["existing-external", "selected-provider"],
      );
      if (!catalog) {
        expect(getPluginRegistryGatewayOwner(selected!)).toBe(gatewayOwner);
        expect(
          selected?.providers.find(({ provider }) => provider.id === "existing-external")?.provider
            .label,
        ).toBe(scenario === "changed registration config" ? "changed" : "startup");
      }
      expect(
        registrations
          .filter(({ id }) => id === "existing-external")
          .every(({ directory }) => directory !== plugins[0]!.dir),
      ).toBe(true);
      await resources[Symbol.asyncDispose]();
      expect(getActivePluginRegistry()).toBe(root);
      expect(startupRegistrations.every(({ directory }) => fs.existsSync(directory))).toBe(true);
    } finally {
      await resources[Symbol.asyncDispose]();
      loaded.retireGatewayRuntimeBindings();
      await disposePluginRegistryInstances(root);
    }
    expect(
      registrations
        .filter(({ id }) => !bundled || id !== "selected-provider")
        .every(({ directory }) => !fs.existsSync(directory)),
    ).toBe(true);
    if (reuses) {
      await using retired = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      expect(() =>
        prepareWorkspacePluginRegistries(
          input,
          metadata,
          (registry) => retired.retainRegistry(registry),
          loadInbound,
          true,
        ),
      ).toThrow(/retired|reloaded or disabled/);
      expect(registrations).toHaveLength(2);
    }
  });
});
