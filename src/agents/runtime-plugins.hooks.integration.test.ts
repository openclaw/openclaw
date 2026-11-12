// Verifies hook dispatch follows configured policy and explicit agent registry scopes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner } from "../plugins/hooks.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import {
  createPreparedModelRuntimeLease,
  retainPreparedPluginGeneration,
} from "./prepared-model-runtime.plugin-lifetime.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it("keeps a prepared registry alive after its temporary caller cache retires", async () => {
  useNoBundledPlugins();
  const closed = path.join(makePluginLoaderTempDir(), "closed");
  const plugin = writePlugin({
    id: "prepared-hook-owner",
    body: `module.exports = { id: "prepared-hook-owner", register(api) {
      api.on("before_prompt_build", async () => ({ prependContext: "prepared-owner" }));
      api.lifecycle.onDispose(() => require("node:fs").appendFileSync(${JSON.stringify(closed)}, "closed\\n"));
    }};`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      slots: { memory: "none" },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const metadataCache = createPluginCache();
  const callerCache = createPluginCache();
  try {
    const metadataSnapshot = withPluginCache(metadataCache, () =>
      loadPluginMetadataSnapshot({ config, workspaceDir, allowCurrent: false }),
    );
    const registry = withPluginCache(callerCache, () =>
      loadAgentRuntimePluginRegistryHandle({ config, workspaceDir, metadataSnapshot }),
    );
    const record = registry.plugins.find(({ id }) => id === plugin.id);
    expect(record?.status).toBe("loaded");
    const instance = record && getPluginInstance(record);
    expect(instance).toBeDefined();
    const hooks = createHookRunner(registry, { catchErrors: false });
    await expect(
      hooks.runBeforePromptBuild({ prompt: "before", messages: [] }, {}),
    ).resolves.toEqual({
      prependContext: "prepared-owner",
    });

    await retirePluginCache(callerCache);
    expect(instance!.lifecycle.signal.aborted).toBe(false);
    expect(fs.existsSync(closed)).toBe(false);
    await expect(
      hooks.runBeforePromptBuild({ prompt: "after", messages: [] }, {}),
    ).resolves.toEqual({
      prependContext: "prepared-owner",
    });
    await retirePluginCache(metadataCache);
    expect(instance!.lifecycle.signal.aborted).toBe(true);
    expect(fs.readFileSync(closed, "utf8")).toBe("closed\n");
    await expect(
      hooks.runBeforePromptBuild({ prompt: "retired", messages: [] }, {}),
    ).rejects.toThrow("Plugin prepared-hook-owner was reloaded or disabled");
  } finally {
    await Promise.all([retirePluginCache(callerCache), retirePluginCache(metadataCache)]);
  }
});

it("does not dispatch hooks from a disabled plugin", async () => {
  useNoBundledPlugins();
  const pluginId = "prompt-hook-probe";
  const plugin = writePlugin({
    id: pluginId,
    body: `module.exports = {
      id: ${JSON.stringify(pluginId)},
      register(api) {
        api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
      },
    };`,
  });
  const config = {
    plugins: {
      entries: { [pluginId]: { enabled: false, hooks: { allowConversationAccess: true } } },
      load: { paths: [plugin.file] },
    },
  } satisfies OpenClawConfig;
  await withAgentPluginRegistry({
    config,
    workspaceDir: makePluginLoaderTempDir(),
    run: async (registry) => {
      const result = await createHookRunner(registry).runBeforePromptBuild(
        { prompt: "test", messages: [] },
        {},
      );
      expect(result?.prependContext).toBeUndefined();
    },
  });
});

it("blocks a tool call through the run's before_tool_call hook when no process registry was activated", async () => {
  // A headless `agent exec` run: nothing activated a root registry, so the global
  // runner did not exist and tool policy let every call through (#158824).
  useNoBundledPlugins();
  resetGlobalHookRunner();
  const pluginId = "headless-tool-guard";
  const plugin = writePlugin({
    id: pluginId,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_tool_call", async (event) => ({ block: true, blockReason: "guarded " + event.toolName }));
  },
};\n`,
  });
  const config = {
    plugins: {
      allow: [pluginId],
      load: { paths: [plugin.file] },
      entries: { [pluginId]: { enabled: true } },
      slots: { memory: "none" },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  expect(getGlobalHookRunner()).toBeNull();
  const outcome = await withAgentPluginRegistry({
    config,
    workspaceDir,
    run: async () => runBeforeToolCallHook({ toolName: "exec", params: { command: "ls -a" } }),
  });
  expect(outcome.blocked).toBe(true);
  expect(outcome.blocked && outcome.reason).toContain("guarded exec");
});

it("keeps exact deferred capabilities and resolved tools, not an unused installed instance", async () => {
  useNoBundledPlugins();
  const unused = writePlugin({ id: "unused", registration: "" });
  const tool = writePlugin({
    id: "selected-tool",
    registration:
      'api.registerTool(() => ({ name: "custody_probe", description: "Probe", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }), { names: ["custody_probe"] });',
  });
  fs.writeFileSync(
    path.join(path.dirname(tool.file), "openclaw.plugin.json"),
    JSON.stringify({
      id: tool.id,
      configSchema: { type: "object", additionalProperties: false },
      contracts: { tools: ["custody_probe"] },
    }),
  );
  const hook = writePlugin({
    id: "deferred-hook",
    registration: 'api.on("agent_end", async () => {});',
  });
  const provider = writePlugin({
    id: "fallback-provider",
    registration: 'api.registerProvider({ id: "fallback-provider", label: "Fallback", auth: [] });',
  });
  const plugins = [unused, tool, hook, provider];
  const config: OpenClawConfig = {
    plugins: {
      allow: plugins.map(({ id }) => id),
      load: { paths: plugins.map(({ file }) => file) },
      entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
      slots: { memory: "none" },
    },
  };
  const workspaceDir = makePluginLoaderTempDir();
  const registry = loadAgentRuntimePluginRegistryHandle({ config, workspaceDir });
  const snapshot = createModelRuntimeChoiceOwnerFixture(config, () => true, {
    pluginRegistry: registry,
  });
  const generation = {
    pluginRegistry: registry,
    pluginMetadataSnapshot: snapshot.metadataSnapshot,
    remoteCatalog: null,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const instances = plugins.map(({ id }) =>
    getPluginInstance(registry.plugins.find((record) => record.id === id)!)!,
  );
  const physical = retainPreparedPluginGeneration(generation);
  expect(instances.map((instance) => instance.retainedWorkCount)).toEqual([0, 0, 0, 0]);
  const lease = createPreparedModelRuntimeLease(snapshot, generation);
  try {
    expect(instances.map((instance) => instance.retainedWorkCount)).toEqual([0, 0, 1, 1]);
    const tools = lease.run!(() =>
      resolvePluginTools({ context: { config, workspaceDir }, runtimeRegistry: registry }),
    );
    expect(tools.map(({ name }) => name)).toContain("custody_probe");
    expect(instances.map((instance) => instance.retainedWorkCount)).toEqual([0, 1, 1, 1]);
    const releaseReplacement = instances[1]!.reserveReplacement();
    try {
      const selected = tools.find(({ name }) => name === "custody_probe")!;
      await expect(lease.run!(() => selected.execute("call", {}))).resolves.toMatchObject({
        content: [],
      });
      expect(instances[1]!.acceptingCalls).toBe(true);
      expect(instances[1]!.retainedWorkCount).toBe(1);
    } finally {
      releaseReplacement();
    }
    const releaseHookReplacement = instances[2]!.reserveReplacement();
    try {
      await expect(
        lease.run!(() =>
          createHookRunner(registry, { catchErrors: false }).runAgentEnd(
            { messages: [], success: true },
            { agentId: "main" },
          ),
        ),
      ).resolves.toBeUndefined();
    } finally {
      releaseHookReplacement();
    }
  } finally {
    await lease[Symbol.asyncDispose]();
    expect(instances.map((instance) => instance.retainedWorkCount)).toEqual([0, 0, 0, 0]);
    await physical();
  }
});
