import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import {
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { buildPreparedPluginModelCatalog } from "./prepared-model-runtime.plugin-generation.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

vi.mock("./model-catalog.js", { spy: true });

describe("prepared model runtime plugin metadata ownership", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  function preparedActivationFixture() {
    const config = { plugins: { entries: { synthetic: { config: { mode: "initial" } } } } };
    const activatedConfig = {
      plugins: {
        entries: {
          synthetic: { ...structuredClone(config.plugins.entries.synthetic), enabled: true },
        },
      },
    };
    const env = { OPENCLAW_ACTIVATION_TEST: "initial" };
    const workspaceDir = "/tmp/prepared-activation-workspace";
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir,
    });
    const registry = createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(
      registry,
      {
        rawConfig: activatedConfig,
        config: activatedConfig,
        activationSourceConfig: config,
        autoEnabledReasons: { synthetic: ["prepared startup decision"] },
        workspaceDir,
        env,
        metadataSnapshot,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        logger: { info() {}, warn() {}, error() {} },
        preferBuiltPluginArtifacts: true,
        expectedSourceDigests: { synthetic: "inbound-source-digest" },
      },
      "inbound-registration",
      { requestKey: "inbound-request", resolvedKey: "inbound-resolved" },
    );
    return { config, activatedConfig, env, workspaceDir, metadataSnapshot, registry };
  }

  it.each(["source", "activated"] as const)(
    "carries admitted activation decisions from %s config into a selected runtime",
    (inputKind) => {
      const fixture = preparedActivationFixture();
      const selectedRegistry = createEmptyPluginRegistry();
      const config = inputKind === "source" ? fixture.config : fixture.activatedConfig;
      prepareOwnedPluginLoadContext(
        { config, workspaceDir: fixture.workspaceDir },
        fixture.env,
        selectedRegistry,
        fixture.metadataSnapshot,
        true,
        fixture.registry,
      );
      const selectedContext = getPluginRuntimeLoadContext(selectedRegistry);
      expect(selectedContext?.config).toBe(fixture.activatedConfig);
      expect(selectedContext?.activationSourceConfig).toBe(fixture.config);
      expect(selectedContext?.autoEnabledReasons).toEqual({
        synthetic: ["prepared startup decision"],
      });
      expect(selectedContext?.metadataSnapshot).toBe(fixture.metadataSnapshot);
      expect(selectedContext?.loaderCacheIdentity).toBeUndefined();
      expect(selectedContext?.registrationConfigKey).not.toBe("inbound-registration");
      expect(selectedContext?.expectedSourceDigests).toBeUndefined();
    },
  );

  it.each(["config", "env", "result", "metadata", "workspace"] as const)(
    "recomputes activation after the prepared %s changes",
    (changed) => {
      const fixture = preparedActivationFixture();
      let metadataSnapshot = fixture.metadataSnapshot;
      if (changed === "config") {
        fixture.config.plugins.entries.synthetic.config.mode = "changed";
      } else if (changed === "env") {
        fixture.env.OPENCLAW_ACTIVATION_TEST = "changed";
      } else if (changed === "result") {
        fixture.activatedConfig.plugins.entries.synthetic.config.mode = "changed";
      } else if (changed === "metadata") {
        metadataSnapshot = { ...metadataSnapshot };
      } else {
        metadataSnapshot = { ...metadataSnapshot, workspaceDir: "/tmp/replacement-workspace" };
      }
      const selectedRegistry = createEmptyPluginRegistry();
      prepareOwnedPluginLoadContext(
        { config: fixture.config, workspaceDir: metadataSnapshot.workspaceDir },
        fixture.env,
        selectedRegistry,
        metadataSnapshot,
        true,
        fixture.registry,
      );
      expect(
        getPluginRuntimeLoadContext(selectedRegistry)?.autoEnabledReasons.synthetic ?? [],
      ).not.toContain("prepared startup decision");
    },
  );

  it("uses one explicit Gateway metadata generation across agent workspaces", async () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const gatewayWorkspace = "/tmp/gateway-plugin-workspace";
    const gatewaySnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir: gatewayWorkspace,
    });
    const inputs = ["first", "second"].map((name) => ({
      agentDir: `/tmp/${name}-agent`,
      config,
      workspaceDir: `/tmp/${name}-workspace`,
    }));
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: gatewaySnapshot,
    };
    const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
    const resolveMetadata = vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot");
    const getCurrentMetadata = vi.spyOn(currentPluginMetadata, "getCurrentPluginMetadataSnapshot");
    let selectedRegistry = createEmptyPluginRegistry();
    const buildCatalog = vi
      .mocked(buildPreparedModelCatalogSnapshot)
      .mockImplementation(async ({ metadataSnapshot }) => {
        expect(metadataSnapshot).toBe(gatewaySnapshot);
        expect(getPluginRuntimeGenerationRegistry() === selectedRegistry).toBe(true);
        return { entries: [], routeVariants: [] };
      });

    try {
      for (const input of inputs) {
        const registry = createEmptyPluginRegistry();
        selectedRegistry = registry;
        expect(
          prepareOwnedPluginLoadContext(input, process.env, registry, gatewaySnapshot, true),
        ).toBe(gatewaySnapshot);
        expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
          metadataSnapshot: gatewaySnapshot,
          preferBuiltPluginArtifacts: true,
        });
        await buildPreparedPluginModelCatalog({
          agentFacts: { input, credentials: {} },
          catalogMode: "static",
          modelRegistry,
          pluginGeneration: { ...pluginGeneration, pluginRegistry: registry },
        });
      }
      expect(getCurrentMetadata.mock.calls.length).toBe(0);
      expect(resolveMetadata.mock.calls.length).toBe(0);
    } finally {
      getCurrentMetadata.mockRestore();
      resolveMetadata.mockRestore();
      buildCatalog.mockRestore();
    }
  });

  it("keeps direct no-current preparation on the requested workspace", () => {
    const config = { plugins: { allow: ["synthetic"] } };
    const workspaceDir = "/tmp/direct-plugin-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "synthetic", channels: [] }]),
      workspaceDir,
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);
    const registry = createEmptyPluginRegistry();

    try {
      expect(
        prepareOwnedPluginLoadContext(
          {
            config,
            workspaceDir,
          },
          process.env,
          registry,
        ),
      ).toBe(directSnapshot);
      expect(getPluginRuntimeLoadContext(registry)).toMatchObject({
        metadataSnapshot: directSnapshot,
        preferBuiltPluginArtifacts: false,
      });
      expect(resolveMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
        allowWorkspaceScopedCurrent: true,
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });

  it("requests selected-runtime metadata for executable prepared probes", () => {
    const config = { plugins: { slots: { memory: "none" as const } } };
    const workspaceDir = "/tmp/selected-runtime-workspace";
    const directSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([{ id: "selected", channels: [] }]),
      workspaceDir,
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(directSnapshot);

    try {
      prepareOwnedPluginLoadContext(
        {
          config,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider: "selected", modelId: "model" }],
          workspaceDir,
        },
        process.env,
        undefined,
      );

      expect(resolveMetadata).toHaveBeenCalledWith({
        config,
        env: process.env,
        workspaceDir,
        allowWorkspaceScopedCurrent: true,
        pluginIdScope: expect.objectContaining({ key: expect.any(String) }),
      });
    } finally {
      resolveMetadata.mockRestore();
    }
  });
});

describe("prepared loader context ownership", () => {
  afterEach(resetPluginLoaderTestStateForTest);

  it("pins explicit inventory across discovery-root changes while ambient loads select fresh sources", () => {
    const root = makePluginLoaderTempDir();
    const id = "inventory-custody";
    const sources = ["A", "B"].map((label) => {
      const bundledRoot = path.join(root, label);
      const plugin = writePlugin({
        id,
        dir: path.join(bundledRoot, id),
        filename: "index.cjs",
        body: `module.exports = { id: "inventory-custody", register(api) {
          api.registerProvider({ id: "inventory-custody", label: ${JSON.stringify(label)}, auth: [] });
        } };`,
      });
      return { bundledRoot, plugin };
    });
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: sources[0]!.bundledRoot,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    };
    const workspaceDir = path.join(root, "workspace");
    const config: OpenClawConfig = {
      plugins: {
        allow: [id],
        slots: { memory: "none" },
        entries: { [id]: { enabled: true } },
      },
    };
    const metadataA = loadPluginMetadataSnapshot({
      config,
      env,
      workspaceDir,
      allowCurrent: false,
    });
    expect(metadataA.manifestRegistry.plugins.map(({ source }) => source)).toEqual([
      sources[0]!.plugin.file,
    ]);
    expect(Object.isFrozen(metadataA)).toBe(true);
    const options = { config, env, workspaceDir, onlyPluginIds: [id] };
    const admittedA = loadPluginRegistryHandle({ ...options, metadataSnapshot: metadataA });
    const labels = (registry: ReturnType<typeof loadPluginRegistryHandle>) =>
      registry.providers.map(({ provider }) => provider.label);
    expect(labels(admittedA)).toEqual(["A"]);

    // Inventory custody differs from activation admission: changing the caller's
    // discovery namespace cannot substitute code inside an explicitly selected generation.
    env.OPENCLAW_BUNDLED_PLUGINS_DIR = sources[1]!.bundledRoot;
    expect(
      getReusablePluginRuntimeActivation(admittedA, { ...options, metadataSnapshot: metadataA }),
    ).toBeUndefined();
    const legacyExplicit = loadPluginRegistryHandle({
      ...options,
      manifestRegistry: metadataA.manifestRegistry,
      discovery: metadataA.discovery,
      installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataA.index),
    });
    const explicit = loadPluginRegistryHandle({ ...options, metadataSnapshot: metadataA });
    const prepared = loadAgentRuntimePluginRegistryHandle({
      config,
      env,
      workspaceDir,
      metadataSnapshot: metadataA,
      basePluginIds: [id],
      purpose: "model-catalog",
    });
    expect(labels(legacyExplicit)).toEqual(["A"]);
    expect(labels(explicit)).toEqual(["A"]);
    expect(labels(prepared)).toEqual(["A"]);
    expect(explicit).not.toBe(admittedA);
    expect(getPluginRuntimeLoadContext(explicit)?.metadataSnapshot).toBe(metadataA);
    expect(getPluginRuntimeLoadContext(prepared)?.metadataSnapshot).toBe(metadataA);

    // Ordinary operation scopes remain discovery-sensitive; immutable runtime scopes do not.
    currentPluginMetadata.withPluginMetadataSnapshotScope(
      metadataA,
      () => {
        expect(currentPluginMetadata.getCurrentPluginMetadataSnapshot(options)).toBeUndefined();
        expect(labels(loadPluginRegistryHandle(options))).toEqual(["B"]);
      },
      {
        config,
        workspaceDir,
        env: { ...env, OPENCLAW_BUNDLED_PLUGINS_DIR: sources[0]!.bundledRoot },
      },
    );
    withPluginRuntimeGenerationScope({ metadataSnapshot: metadataA }, () => {
      expect(pluginMetadata.resolvePluginMetadataSnapshot(options)).toBe(metadataA);
    });
    const metadataB = loadPluginMetadataSnapshot({ ...options, allowCurrent: false });
    expect(metadataB.manifestRegistry.plugins.map(({ source }) => source)).toEqual([
      sources[1]!.plugin.file,
    ]);
    expect(labels(loadPluginRegistryHandle({ ...options, metadataSnapshot: metadataB }))).toEqual([
      "B",
    ]);
    // Conflicting explicit manifests must not label source B with inventory A's identity.
    const conflicting = loadPluginRegistryHandle({
      ...options,
      metadataSnapshot: metadataA,
      manifestRegistry: metadataB.manifestRegistry,
      installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataB.index),
    });
    expect(labels(conflicting)).toEqual(["B"]);
    expect(getPluginRuntimeLoadContext(conflicting)?.metadataSnapshot).toBeUndefined();
  });

  it.each([false, true])("records exact scoped registration facts with empty scope=%s", (empty) => {
    const root = makePluginLoaderTempDir();
    const id = "prepared-context";
    const plugin = writePlugin({
      id,
      dir: path.join(root, id),
      filename: "index.cjs",
      configSchema: { type: "object", properties: { value: { type: "string" } } },
      body: `module.exports = { id: "prepared-context", register(api) {
        api.registerProvider({ id: "prepared-provider", label: api.pluginConfig.value, auth: [] });
      } };`,
    });
    const env = {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      PREPARED_CONTEXT_ENV: "base",
    };
    const workspaceDir = path.join(root, "workspace");
    const broad: OpenClawConfig = {
      env: { vars: { PREPARED_CONTEXT_ENV: "configured", PREPARED_ADDED_ENV: "configured-only" } },
      plugins: {
        load: { paths: [plugin.dir] },
        slots: { memory: "none" },
        entries: { [id]: { enabled: true, config: { value: "runtime" } } },
      },
    };
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: broad,
      env,
      workspaceDir,
      allowCurrent: false,
    });
    const config: OpenClawConfig = { ...broad, plugins: { ...broad.plugins, allow: [id] } };
    const source: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: { [id]: { enabled: true, config: { value: "source" } } },
      },
    };
    const options = {
      config,
      activationSourceConfig: source,
      env,
      workspaceDir,
      metadataSnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      installRecords: {},
      onlyPluginIds: empty ? [] : [id],
      preferBuiltPluginArtifacts: true,
      resolveRawConfigEnvVars: true,
    };
    const registry = loadPluginRegistryHandle(options);
    const actual = getPluginRuntimeLoadContext(registry)!;
    expect(actual).toBeDefined();
    expect(actual.metadataSnapshot).toBe(metadataSnapshot);
    expect(actual.rawConfig).toBe(config);
    expect(actual.config.plugins?.allow).toEqual([id]);
    expect(actual.config.plugins?.entries?.[id]?.config).toEqual({ value: "runtime" });
    expect(actual.activationSourceConfig.plugins?.entries?.[id]?.config).toEqual({
      value: "source",
    });
    expect(actual.env).not.toBe(env);
    // Config environment overlays preserve an already supplied explicit variable.
    expect(actual.env.PREPARED_CONTEXT_ENV).toBe("base");
    expect(actual.env.PREPARED_ADDED_ENV).toBe("configured-only");
    expect(actual.preferBuiltPluginArtifacts).toBe(true);
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(
      empty ? [] : ["runtime"],
    );
    const request = { config, env: actual.env, workspaceDir, metadataSnapshot };
    expect(getReusablePluginRuntimeActivation(registry, request)?.config).toBe(actual.config);
    for (const changed of [
      { config: broad },
      { config: { ...config, plugins: { ...config.plugins, deny: [id] } } },
      {
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            entries: { [id]: { enabled: true, config: { value: "changed" } } },
          },
        },
      },
      { env: { ...actual.env, PREPARED_CONTEXT_ENV: "changed" } },
      { workspaceDir: path.join(root, "other-workspace") },
      { metadataSnapshot: { ...metadataSnapshot } },
    ]) {
      expect(
        getReusablePluginRuntimeActivation(registry, { ...request, ...changed }),
      ).toBeUndefined();
    }
    if (!empty) {
      expect(actual.loaderCacheIdentity).toBeDefined();
      // Raw env substitution intentionally disables registry caching.
      const cacheOptions = { ...options, env: actual.env, resolveRawConfigEnvVars: false };
      const cached = loadPluginRegistryHandle(cacheOptions);
      expect(loadPluginRegistryHandle(cacheOptions)).toBe(cached);
      const replacement = loadPluginRegistryHandle({
        ...cacheOptions,
        metadataSnapshot: { ...metadataSnapshot },
      });
      expect(replacement).not.toBe(cached);
      expect(getPluginRuntimeLoadContext(registry)).toBe(actual);
      const changedSource = loadPluginRegistryHandle({
        ...cacheOptions,
        activationSourceConfig: config,
      });
      expect(changedSource).not.toBe(cached);
      expect(getPluginRuntimeLoadContext(changedSource)?.registrationConfigKey).not.toBe(
        actual.registrationConfigKey,
      );
    }
  });
});
