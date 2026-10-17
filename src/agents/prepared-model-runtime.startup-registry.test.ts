import fs from "node:fs";
import path from "node:path";
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
import type { RuntimePluginLoadPurpose } from "./harness/runtime-plugin-load-plan.js";
import {
  createPreparedInboundRegistryLoader,
  loadPreparedInboundPluginRegistry,
  prepareWorkspacePluginRegistries,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function startupFixture(
  id: string,
  model: string,
  registration: (event: string) => string,
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

it.each<[boolean, boolean, RuntimePluginLoadPurpose]>([
  [false, true, "agent"],
  [true, true, "agent"],
  [false, false, "agent"],
  [true, true, "model-catalog"],
])(
  "borrows startup captures only for admitted selected owners (inspection=%s, selected=%s, purpose=%s)",
  async (inspection, selectedAtStartup, purpose) => {
    using fixture = startupFixture(
      "selected-provider",
      "selected/model",
      (event) => `process.emit(${JSON.stringify(event)}, __dirname);
        api.registerProvider({ id: "selected", label: "Selected", auth: [] });`,
    );
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
        expect(root.plugins).toEqual(
          selectedAtStartup ? [expect.objectContaining({ id: plugin.id, status: "loaded" })] : [],
        );
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
