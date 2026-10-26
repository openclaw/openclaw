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
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
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
