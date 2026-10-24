import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import * as pluginModuleRuntime from "../plugins/loader-module-runtime.js";
import { loadAndActivateRootPluginRegistry as activateRoot } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot as loadMetadata } from "../plugins/plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { ensureSelectedAgentHarnessPlugin as ensureHarness } from "./harness/runtime-plugin.js";
import { model, providerConfig } from "./model-catalog-fixtures.test-support.js";
import { prepareWorkspacePluginRegistries as prepareRegistries } from "./prepared-model-runtime.inbound-registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("prepares an agent-local Copilot BYOK harness without replacing the active root registry", async () => {
  const openStore = vi
    .spyOn(pluginState, "createPluginStateSyncKeyedStore")
    .mockImplementation(() => {
      throw new Error("prepared harness discovery must not activate state stores");
    });
  const workspaceDir = fs.realpathSync(makePluginLoaderTempDir());
  const bundledRoot = path.resolve(import.meta.dirname, "../../extensions");
  const entrypoint = path.join(bundledRoot, "copilot", "index.ts");
  const plugin = await loadBundledPluginFacade({
    pluginId: "copilot",
    artifactBasename: "index.ts",
  });
  // Reuse Vitest's source graph at the module-loading seam. The real loader
  // still discovers and validates the entrypoint and owns registration.
  const loadModule = Object.assign(
    vi.fn((...[source]: Parameters<pluginModuleRuntime.PluginModuleLoader>) => {
      expect(source).toBe(entrypoint);
      return plugin;
    }),
    {
      prepare: vi.fn(async () => {
        throw new Error("bundled harness must not prepare an external plugin artifact");
      }),
    },
  );
  vi.spyOn(pluginModuleRuntime, "createPluginModuleLoader").mockReturnValue(loadModule);
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: fs.realpathSync(makePluginLoaderTempDir()),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  };
  const modelRef = "custom-proxy/test-model";
  const worker = { model: modelRef, models: { [modelRef]: { agentRuntime: { id: "copilot" } } } };
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { worker } },
    ...providerConfig("custom-proxy", {
      api: "openai-responses",
      baseUrl: "https://api.example.com/v1",
      models: [model("test-model")],
    }),
    plugins: { allow: ["copilot"], slots: { memory: "none" } },
  };
  const options = { config, env, workspaceDir };
  const root = await activateRoot({ ...options, onlyPluginIds: [], cache: false });
  const metadata = loadMetadata({
    ...options,
    pluginIds: ["copilot"],
    allowCurrent: false,
    preferPersisted: false,
  });
  const selection = { agentId: "worker", provider: "custom-proxy", modelId: "test-model" };
  const { runtimePluginRegistry: registry } = await prepareRegistries(
    {
      ...options,
      agentDir: workspaceDir,
      loadRuntimePlugins: true,
      runtimePluginSelections: [selection],
    },
    metadata,
    vi.fn(),
  );

  expect(registry).not.toBe(root);
  expect(loadModule).toHaveBeenCalledOnce();
  const owner = loadModule.mock.calls[0]?.[1];
  expect(owner?.registry).toBe(registry);
  expect(owner?.record).toBe(registry?.plugins[0]);
  expect(owner?.rootDir).toBe(path.dirname(entrypoint));
  expect(getActivePluginRegistry()).toBe(root);
  expect(root.agentHarnesses).toEqual([]);
  expect(registry?.plugins).toEqual([
    expect.objectContaining({ id: "copilot", status: "loaded", source: entrypoint }),
  ]);
  await expect(
    ensureHarness({ ...selection, config, workspaceDir, pluginRegistry: registry }),
  ).resolves.toBeUndefined();
  const harness = registry?.agentHarnesses.find((entry) => entry.harness.id === "copilot")?.harness;
  expect(
    harness?.supports({
      ...selection,
      requestedRuntime: "copilot",
      providerOwnerStatus: "unowned",
      providerOwnerPluginIds: [],
      modelProvider: config.models!.providers!["custom-proxy"],
    }),
  ).toEqual({ supported: true, priority: 100 });
  await harness?.dispose?.();
  expect(openStore).not.toHaveBeenCalled();
});
