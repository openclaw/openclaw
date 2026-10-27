import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "../plugins/hooks.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryGatewayOwner,
  getPluginRegistryGatewayOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { RuntimePluginLoadPurpose } from "./harness/runtime-plugin-load-plan.js";
import {
  createPreparedInboundRegistryLoader,
  loadPreparedInboundPluginRegistry,
  prepareWorkspacePluginRegistries,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  PreparedModelRuntimeBuildResources,
  retainPreparedModelRuntimeSnapshotResources,
} from "./prepared-model-runtime.resources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function startupFixture(
  id: string,
  model = "selected/model",
  registration = (event: string) => `process.emit(${JSON.stringify(event)}, __dirname);
      api.registerProvider({ id: "selected", label: "Selected", auth: [] });`,
  hooks = false,
) {
  useNoBundledPlugins();
  const workspaceDir = tempDirs.make("openclaw-prepared-workspace-");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-state-"));
  const event = `${id}:${workspaceDir}`;
  const captures: string[] = [];
  const capture = (value: string) => captures.push(value);
  process.on(event, capture);
  const plugin = writePlugin({
    id,
    dir: tempDirs.make("openclaw-prepared-plugin-"),
    registration: registration(event),
  });
  const config: OpenClawConfig = {
    agents: { defaults: { model } },
    plugins: {
      allow: [id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: {
        [id]: { enabled: true, ...(hooks ? { hooks: { allowConversationAccess: true } } : {}) },
      },
    },
  };
  const input = { config, workspaceDir, agentDir: workspaceDir, allowGatewaySubagentBinding: true };
  const start = async (onlyPluginIds: string[], channelPluginLoadIntent?: "full") => {
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
    const root = await loadAndActivateRootPluginRegistry({
      config,
      workspaceDir,
      manifestRegistry: metadata.manifestRegistry,
      discovery: metadata.discovery,
      onlyPluginIds,
      channelPluginLoadIntent,
      runtimeOptions: { allowGatewaySubagentBinding: true },
      cache: false,
      throwOnLoadError: true,
    });
    prepareOwnedPluginLoadContext(input, process.env, root, metadata, true);
    return { root, metadata };
  };
  return { plugin, input, captures, start, [Symbol.dispose]: () => process.off(event, capture) };
}

async function loadRegistryInCallerContext(
  context: AsyncLocalStorage<object>,
  resources: PreparedModelRuntimeBuildResources,
  input: Parameters<PreparedModelRuntimeBuildResources["load"]>[0],
) {
  const caller = { transcript: ["settled caller transcript"] };
  const reference = new WeakRef(caller);
  const registry = await context.run(caller, () => resources.load(input, () => {}));
  return { registry, reference };
}

it("releases the acquiring caller context while a prepared registry remains retained", async () => {
  using fixture = startupFixture("retained-catalog");
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const { root, metadata } = await fixture.start([]);
    const context = new AsyncLocalStorage<object>();
    await using resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    const { registry, reference } = await loadRegistryInCallerContext(context, resources, {
      ...fixture.input,
      metadataSnapshot: metadata,
      preferBuiltPluginArtifacts: true,
      basePluginIds: [],
      purpose: "model-catalog",
    });
    const claim = retainPreparedModelRuntimeSnapshotResources({ pluginRegistry: registry });
    expect(claim).toBeDefined();
    try {
      await resources[Symbol.asyncDispose]();
      await setImmediate();
      queryObjects(WeakRef);
      expect(() => claim!.assertOpen()).not.toThrow();
      expect(context.getStore()).toBeUndefined();
      expect(reference.deref()).toBeUndefined();
    } finally {
      context.disable();
      await claim?.release();
      await disposePluginRegistryInstances(root);
    }
  });
});

it.each<[boolean, boolean, RuntimePluginLoadPurpose]>([
  [false, true, "agent"],
  [true, true, "agent"],
  [false, false, "agent"],
  [true, true, "model-catalog"],
])(
  "borrows startup captures only for admitted selected owners (inspection=%s, selected=%s, purpose=%s)",
  async (inspection, selectedAtStartup, purpose) => {
    using fixture = startupFixture("selected-provider");
    const { plugin, captures } = fixture;
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({ id: plugin.id, configSchema: EMPTY_PLUGIN_SCHEMA, providers: ["selected"] }),
    );
    const input = {
      ...fixture.input,
      runtimePluginSelections: [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
    };
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const { root, metadata } = await fixture.start(selectedAtStartup ? [plugin.id] : []);
      const gatewayOwner = { current: () => root };
      bindPluginRegistryGatewayOwner(root, gatewayOwner);
      const resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      const loadInbound = createPreparedInboundRegistryLoader();
      let selected: PluginRegistry | undefined;
      try {
        expect(captures).toHaveLength(selectedAtStartup ? 1 : 0);
        const startupCapture = captures[0];
        const prepared = await withPluginRuntimeRegistryScope(root, async () => {
          if (purpose === "model-catalog") {
            let primaryRegistry: PluginRegistry | undefined;
            const runtimePluginRegistry = await resources.load(
              {
                ...input,
                metadataSnapshot: metadata,
                preferBuiltPluginArtifacts: true,
                basePluginIds: [],
                purpose,
              },
              (registry) => {
                primaryRegistry = registry;
              },
            );
            return { runtimePluginRegistry, primaryRegistry, inboundPluginRegistry: undefined };
          }
          return prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => resources.retainRegistry(registry),
            loadInbound,
            true,
            undefined,
            () => [],
            undefined,
            inspection ? resources.load.bind(resources) : undefined,
          );
        });
        selected = prepared.runtimePluginRegistry;
        expect(prepared.inboundPluginRegistry === root).toBe(purpose === "agent");
        expect(captures).toHaveLength(1);
        expect(captures[0]).not.toBe(plugin.dir);
        const reused = purpose === "agent" && selectedAtStartup;
        expect(selected === root).toBe(reused);
        expect(prepared.primaryRegistry === root).toBe(reused);
        expect(selected?.providers.map(({ provider }) => provider.id)).toEqual(
          purpose === "agent" ? ["selected"] : [],
        );
        if (purpose === "agent") {
          expect(getPluginRegistryGatewayOwner(selected!)).toBe(gatewayOwner);
        }
        await resources[Symbol.asyncDispose]();
        expect(getActivePluginRegistry()).toBe(root);
        if (startupCapture) {
          expect(captures).toEqual([startupCapture]);
          expect(fs.existsSync(startupCapture)).toBe(true);
        }
      } finally {
        await resources[Symbol.asyncDispose]();
        if (selected && selected !== root) {
          await disposePluginRegistryInstances(selected);
        }
        await disposePluginRegistryInstances(root);
      }
      expect(captures.every((directory) => !fs.existsSync(directory))).toBe(true);
      if (purpose === "agent") {
        await using retiredBuild = new PreparedModelRuntimeBuildResources(
          retainPreparedPluginRegistry,
        );
        expect(() =>
          prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => retiredBuild.retainRegistry(registry),
            loadInbound,
            true,
          ),
        ).toThrow(/retired|reloaded or disabled/);
        expect(captures).toHaveLength(1);
      }
    });
  },
);

it("borrows global startup instances across workspaces without borrowing shadowed sources", async () => {
  using fixture = startupFixture("global-startup-provider");
  const { config } = fixture.input;
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const firstWorkspace = path.join(fixture.input.workspaceDir, "first");
    const rootMetadata = loadPluginMetadataSnapshot({ config, workspaceDir: firstWorkspace });
    const root = await loadAndActivateRootPluginRegistry({
      config,
      metadataSnapshot: rootMetadata,
      onlyPluginIds: [fixture.plugin.id],
      runtimeOptions: { allowGatewaySubagentBinding: true },
      cache: false,
      throwOnLoadError: true,
    });
    const gateway = createPluginRegistryOwner(root);
    const context = getPluginRuntimeLoadContext(root);
    const loadInbound = createPreparedInboundRegistryLoader();
    try {
      expect(rootMetadata.workspaceDir).toBe(firstWorkspace);
      expect(context?.workspaceDir).toBeUndefined();
      await using resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      for (const agent of ["first", "second"]) {
        const workspaceDir = path.join(fixture.input.workspaceDir, agent);
        const shadow = agent === "second";
        const shadowPlugin = shadow
          ? writePlugin({
              id: fixture.plugin.id,
              dir: path.join(workspaceDir, ".openclaw", "extensions", fixture.plugin.id),
              filename: "index.cjs",
              registration:
                'api.registerProvider({ id: "selected", label: "Workspace", auth: [] });',
            })
          : undefined;
        const selectedConfig = shadow
          ? { ...config, plugins: { ...config.plugins, load: { paths: [] } } }
          : config;
        const metadata = shadow
          ? loadPluginMetadataSnapshot({ config: selectedConfig, workspaceDir })
          : rootMetadata;
        const input = {
          ...fixture.input,
          config: selectedConfig,
          workspaceDir,
          runtimePluginSelections: [
            { provider: "selected", modelId: "model", runtime: "openclaw" },
          ],
        };
        const prepared = await withPluginRuntimeRegistryScope(root, () =>
          prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => resources.retainRegistry(registry),
            loadInbound,
            true,
            undefined,
            () => [],
          ),
        );
        prepareOwnedPluginLoadContext(
          input,
          process.env,
          prepared.runtimePluginRegistry,
          metadata,
          true,
          prepared.inboundPluginRegistry,
        );
        const record = prepared.runtimePluginRegistry?.plugins.find(
          (plugin) => plugin.id === fixture.plugin.id,
        );
        expect(record?.status).toBe("loaded");
        expect(record === root.plugins[0]).toBe(!shadow);
        expect(record?.source).toBe(shadowPlugin?.file ?? fixture.plugin.file);
        expect(prepared.runtimePluginRegistry?.providers[0]?.provider.label).toBe(
          shadow ? "Workspace" : "Selected",
        );
        expect(getPluginRuntimeLoadContext(root)).toBe(context);
        expect(getPluginRuntimeLoadContext(root)?.workspaceDir).toBeUndefined();
        expect(fixture.captures).toHaveLength(1);
      }
    } finally {
      await gateway.close();
    }
  });
});

it.each(["inbound", "selected", "inspection"] as const)(
  "borrows hooks from the current Gateway through %s preparation",
  async (producer) => {
    using fixture = startupFixture(
      "owned-hook",
      "selected/gateway",
      (event) => `const owner = api.config.agents.defaults.model;
        api.on("before_prompt_build", () => {
          process.emit(${JSON.stringify(event)}, owner);
          return { prependContext: owner };
        });`,
      true,
    );
    const { plugin, input, captures: calls } = fixture;
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const { root: gatewayRegistry, metadata } = await fixture.start([plugin.id], "full");
      const gateway = createPluginRegistryOwner(gatewayRegistry, input.workspaceDir);
      const closing = createEmptyPluginRegistry();
      closing.plugins.push(...gateway.registry.plugins);
      bindPluginRegistryGatewayOwner(closing, { current: () => undefined });
      const run = async (request: PluginRegistry | undefined, borrowed: boolean) => {
        await using resources = new PreparedModelRuntimeBuildResources(
          retainPreparedPluginRegistry,
        );
        const registry = await withPluginRuntimeRegistryScope(request, async () => {
          if (producer === "inbound") {
            const loaded = loadPreparedInboundPluginRegistry(input, metadata);
            resources.retainRegistry(loaded);
            return loaded;
          }
          const prepared = await prepareWorkspacePluginRegistries(
            input,
            metadata,
            (value) => resources.retainRegistry(value),
            undefined,
            true,
            undefined,
            () => [],
            [plugin.id],
            producer === "inspection" ? resources.load.bind(resources) : undefined,
          );
          return prepared.runtimePluginRegistry;
        });
        if (!registry) {
          throw new Error("Expected a prepared registry");
        }
        const result = await createHookRunner(registry, {
          catchErrors: false,
        }).runBeforePromptBuild({ prompt: "probe", messages: [] }, {});
        expect.soft(result?.prependContext).toBe("selected/gateway");
        expect.soft(calls.splice(0)).toEqual(["selected/gateway"]);
        expect.soft(registry.plugins[0] === gateway.registry.plugins[0]).toBe(borrowed);
      };
      try {
        expect(getActivePluginRegistry()).toBe(gateway.registry);
        await run(gateway.registry, true);
        await run(undefined, false);
        await run(closing, false);
      } finally {
        await gateway.close();
      }
    });
  },
);
