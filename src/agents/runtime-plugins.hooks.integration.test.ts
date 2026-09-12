// Verifies hook dispatch follows configured policy and explicit agent registry scopes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
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

it.each([
  "configured",
  "globally disabled",
  "disabled plugin",
  "not allowlisted",
  "denied plugin",
  "empty base",
  "empty request",
])("dispatches configured hooks while preserving %s scope", async (scope) => {
  useNoBundledPlugins();
  const pluginId = "prompt-hook-probe";
  const plugin = writePlugin({
    id: pluginId,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
  },
};\n`,
  });
  const config = {
    plugins: {
      enabled: scope !== "globally disabled",
      ...(scope === "not allowlisted" ? { allow: ["other-plugin"] } : {}),
      ...(scope === "denied plugin" ? { deny: [pluginId] } : {}),
      entries: {
        [pluginId]: {
          enabled: scope !== "disabled plugin",
          hooks: { allowConversationAccess: true },
        },
      },
      load: { paths: [plugin.file] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const run = async (registry: PluginRegistry) => {
    const result = await createHookRunner(registry).runBeforePromptBuild(
      { prompt: "test", messages: [] },
      {},
    );
    expect(result?.prependContext).toBe(scope === "configured" ? "hook-injected" : undefined);
  };
  if (scope === "empty base") {
    await run(loadAgentRuntimePluginRegistryHandle({ config, workspaceDir, basePluginIds: [] }));
  } else if (scope === "empty request") {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
      withAgentPluginRegistry({ config, workspaceDir, run }),
    );
  } else {
    await withAgentPluginRegistry({ config, workspaceDir, run });
  }
});
