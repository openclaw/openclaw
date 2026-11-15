import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
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
import { getPluginInstance, pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import { createModelRuntimeChoiceOwnerFixture } from "./model-runtime-choice.test-support.js";
import { createPreparedModelRuntimeLease } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);
beforeEach(useNoBundledPlugins);

function pluginConfig(
  plugin: ReturnType<typeof writePlugin>,
  entry: PluginEntryConfig,
): OpenClawConfig {
  return {
    plugins: {
      load: { paths: [plugin.file] },
      entries: { [plugin.id]: entry },
      ...(entry.enabled ? { allow: [plugin.id], slots: { memory: "none" } } : {}),
    },
  };
}

it("keeps a prepared registry alive after its temporary caller cache retires", async () => {
  const closed = path.join(makePluginLoaderTempDir(), "closed");
  const plugin = writePlugin({
    id: "prepared-hook-owner",
    registration: `      api.on("before_prompt_build", async () => ({ prependContext: "prepared-owner" }));
      api.lifecycle.onDispose(() => require("node:fs").appendFileSync(${JSON.stringify(closed)}, "closed\\n"));`,
  });
  const config = pluginConfig(plugin, { enabled: true, hooks: { allowConversationAccess: true } });
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
    const record = registry.plugins.find(({ id }) => id === plugin.id)!;
    const instance = getPluginInstance(record)!;
    expect(record.status).toBe("loaded");
    const hooks = createHookRunner(registry, { catchErrors: false });
    const buildPrompt = (prompt: string) =>
      hooks.runBeforePromptBuild({ prompt, messages: [] }, {});
    await expect(buildPrompt("before")).resolves.toEqual({ prependContext: "prepared-owner" });

    await retirePluginCache(callerCache);
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(fs.existsSync(closed)).toBe(false);
    await expect(buildPrompt("after")).resolves.toEqual({ prependContext: "prepared-owner" });
    await retirePluginCache(metadataCache);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(fs.readFileSync(closed, "utf8")).toBe("closed\n");
    await expect(buildPrompt("retired")).rejects.toThrow(
      "Plugin prepared-hook-owner was reloaded or disabled",
    );
  } finally {
    await Promise.all([retirePluginCache(callerCache), retirePluginCache(metadataCache)]);
  }
});

it("does not dispatch hooks from a disabled plugin", async () => {
  const plugin = writePlugin({
    id: "prompt-hook-probe",
    registration: `        api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));`,
  });
  const result = await withAgentPluginRegistry({
    config: pluginConfig(plugin, { enabled: false, hooks: { allowConversationAccess: true } }),
    workspaceDir: makePluginLoaderTempDir(),
    run: (registry) =>
      createHookRunner(registry).runBeforePromptBuild({ prompt: "test", messages: [] }, {}),
  });
  expect(result?.prependContext).toBeUndefined();
});

it("blocks a tool call through the run's before_tool_call hook when no process registry was activated", async () => {
  // Headless agent exec must enforce hooks without a global registry (#158824).
  resetGlobalHookRunner();
  const plugin = writePlugin({
    id: "headless-tool-guard",
    registration: `    api.on("before_tool_call", async (event) => ({ block: true, blockReason: "guarded " + event.toolName }));`,
  });
  expect(getGlobalHookRunner()).toBeNull();
  const outcome = await withAgentPluginRegistry({
    config: pluginConfig(plugin, { enabled: true }),
    workspaceDir: makePluginLoaderTempDir(),
    run: async () => runBeforeToolCallHook({ toolName: "exec", params: { command: "ls -a" } }),
  });
  expect(outcome).toMatchObject({ blocked: true, reason: expect.stringContaining("guarded exec") });
});

it("retains resolved capabilities through nested runtime scopes without pinning an unused plugin", async () => {
  const empty = writePlugin({ id: "unused-advisor", registration: "" });
  const tool = writePlugin({
    id: "resolved-tool",
    registration: `api.registerTool(() => ({ name: "lease_probe", description: "Probe", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }), { names: ["lease_probe"] });`,
  });
  fs.writeFileSync(
    path.join(tool.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: tool.id,
      configSchema: { type: "object", additionalProperties: false },
      contracts: { tools: ["lease_probe"] },
      reload: { turnHandover: true },
    }),
  );
  const hook = writePlugin({
    id: "terminal-hook",
    registration: `api.on("agent_end", async () => {});`,
  });
  const provider = writePlugin({
    id: "fallback-provider",
    registration: `api.registerProvider({ id: "fallback-provider", label: "Fallback", auth: [] });`,
  });
  const plugins = [empty, tool, hook, provider];
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: plugins.map(({ file }) => file) },
      allow: plugins.map(({ id }) => id),
      entries: Object.fromEntries(
        plugins.map(({ id }) => [id, { enabled: true, hooks: { allowConversationAccess: true } }]),
      ),
      slots: { memory: "none" },
    },
  };
  const workspaceDir = makePluginLoaderTempDir();
  await withAgentPluginRegistry({
    config,
    workspaceDir,
    run: async (registry) => {
      const selectedRegistry = {
        ...registry,
        plugins: registry.plugins.filter(({ id }) => id !== tool.id),
        tools: [],
      };
      const snapshot = createModelRuntimeChoiceOwnerFixture(config, () => true, {
        pluginRegistry: selectedRegistry,
      });
      const generation = {
        pluginRegistry: selectedRegistry,
        pluginMetadataSnapshot: snapshot.metadataSnapshot,
        remoteCatalog: null,
        inlineProviderModels: [],
        configuredCatalogEntries: [],
      };
      const leases = Array.from({ length: 17 }, () =>
        createPreparedModelRuntimeLease(snapshot, generation),
      );
      const instance = (id: string) =>
        getPluginInstance(registry.plugins.find((record) => record.id === id)!)!;
      let toolOwner: ReturnType<typeof getPluginInstance>;
      try {
        expect(instance(empty.id).retainedWorkCount).toBe(0);
        expect(instance(tool.id).retainedWorkCount).toBe(0);
        // Late terminal hooks and fallback providers cannot discard their captured generation.
        expect(instance(hook.id).retainedWorkCount).toBe(17);
        expect(instance(provider.id).retainedWorkCount).toBe(17);
        await leases[0]!.run(() =>
          withAgentPluginRegistry({
            config,
            workspaceDir,
            selections: [],
            run: async (nested) => {
              const resolved = resolvePluginTools({
                context: { config, workspaceDir },
                runtimeRegistry: nested,
              });
              expect(resolved.map(({ name }) => name)).toContain("lease_probe");
              const held = pluginInvocationContext.getStore()!.retainedInstances!;
              const toolOwners = held.filter(({ pluginId }) => pluginId === tool.id);
              expect(toolOwners).toHaveLength(1);
              toolOwner = toolOwners[0];
              expect(held.some(({ pluginId }) => pluginId === empty.id)).toBe(false);
              expect(toolOwner!.retainedWorkCount).toBe(1);
              expect(instance(tool.id).retainedWorkCount).toBe(0);
              expect(instance(empty.id).retainedWorkCount).toBe(0);
            },
          }),
        );
        expect(toolOwner!.retainedWorkCount).toBe(1);
        const releaseReplacement = toolOwner!.reserveReplacement();
        try {
          await expect.poll(() => toolOwner!.retainedWorkCount).toBe(0);
        } finally {
          releaseReplacement();
        }
      } finally {
        for (const lease of leases) {
          await lease[Symbol.asyncDispose]();
        }
      }
      expect(plugins.map(({ id }) => instance(id).retainedWorkCount)).toEqual([0, 0, 0, 0]);
      expect(toolOwner!.retainedWorkCount).toBe(0);
    },
  });
});
