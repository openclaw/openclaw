// Exercises channel policies through agent generation loading and the tool execution gate.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import {
  acquireAgentRuntimePluginRegistry,
  loadAgentRuntimePluginRegistryHandle,
} from "./runtime-plugins.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function createChannelFixture(legacyModes = false) {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  const registered = path.join(workspaceDir, "registered");
  const executed = path.join(workspaceDir, "executed");
  const plugin = writePlugin({
    id: "channel-hook-probe",
    filename: "index.ts",
    body: `import { appendFileSync } from "node:fs";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
let runtime;
const entry = defineChannelPluginEntry({
  id: "channel-hook-probe", name: "Probe", description: "Probe",
  plugin: {
    id: "channel-hook-probe",
    meta: { id: "channel-hook-probe", label: "Probe", selectionLabel: "Probe", docsPath: "/probe", blurb: "Probe" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => [], resolveAccount: () => ({}) }
  },
  setRuntime(value) { runtime = value; },
  registerFull(api) {
    if (api.registrationMode === "agent-runtime" && !runtime) throw new Error("channel runtime missing");
    appendFileSync(${JSON.stringify(registered)}, api.registrationMode + "\\n");
    api.on("before_tool_call", (event) => event.params.gate === "hook" ? { block: true, blockReason: "channel hook gate" } : undefined);
    api.registerTrustedToolPolicy({ id: "probe-policy", description: "Probe policy", evaluate: (event) => event.params.gate === "policy" ? { block: true, blockReason: "channel policy gate" } : undefined });
    api.registerTool({ name: "probe_tool", label: "Probe", description: "Probe tool", parameters: { type: "object", properties: {} }, execute: async () => {
      appendFileSync(${JSON.stringify(executed)}, "executed\\n");
      return { content: [{ type: "text", text: "executed" }], details: {} };
    }});
  }
});
export default ${legacyModes ? `{ ...entry, register(api) { if (api.registrationMode === "full" || api.registrationMode === "tool-discovery") entry.register(api); else api.registerChannel({ plugin: entry.channelPlugin }); } }` : "entry"};`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      channels: [plugin.id],
      channelConfigs: { [plugin.id]: { schema: { type: "object", properties: {} } } },
      contracts: { tools: ["probe_tool"], trustedToolPolicies: ["probe-policy"] },
      configSchema: { type: "object", properties: {} },
    }),
  );
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      slots: { memory: "none" },
    },
  } satisfies OpenClawConfig;
  return { plugin, config, workspaceDir, registered, executed };
}

it.each(["fresh", "discovery reuse", "tool discovery reuse", "acquired"] as const)(
  "enforces channel hooks and policies before tool execution in a %s agent generation",
  async (kind) => {
    const { plugin, config, workspaceDir, registered, executed } = createChannelFixture();
    const metadataSnapshot = loadPluginMetadataSnapshot({ config, workspaceDir });
    const reusableRegistry =
      kind === "discovery reuse" || kind === "tool discovery reuse"
        ? loadOpenClawPlugins({
            config,
            workspaceDir,
            activate: false,
            toolDiscovery: kind === "tool discovery reuse",
          })
        : undefined;
    const params = {
      config,
      workspaceDir,
      metadataSnapshot,
      basePluginIds: [plugin.id],
      reusableRegistry,
    };
    let registry: PluginRegistry;
    let releaseRegistry: (() => Promise<void>) | undefined;
    if (kind === "acquired") {
      const acquired = await acquireAgentRuntimePluginRegistry(params);
      registry = acquired.registry;
      if ("releaseRegistry" in acquired) {
        releaseRegistry = acquired.releaseRegistry;
      }
    } else {
      registry = loadAgentRuntimePluginRegistryHandle(params);
    }
    try {
      expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
      expect(registry.channels.map((entry) => entry.plugin.id)).toContain(plugin.id);
      initializeGlobalHookRunner(createEmptyPluginRegistry());
      await withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: registry },
        async () => {
          const tools = resolvePluginTools({
            context: { config, workspaceDir },
            runtimeRegistry: registry,
          });
          expect(tools.map((tool) => tool.name)).toEqual(["probe_tool"]);
          const tool = wrapToolWithBeforeToolCallHook(
            tools[0]!,
            { config },
            { emitDiagnostics: false },
          );
          for (const gate of ["hook", "policy"]) {
            await expect(tool.execute(`blocked-${gate}`, { gate })).resolves.toMatchObject({
              details: { status: "blocked", reason: `channel ${gate} gate` },
            });
            await expect(
              runBeforeToolCallHook({ toolName: "exec", params: { gate }, ctx: { config } }),
            ).resolves.toMatchObject({ blocked: true, reason: `channel ${gate} gate` });
          }
          expect(fs.existsSync(executed)).toBe(false);
          await tool.execute("allowed", {});
          expect(fs.readFileSync(executed, "utf8")).toBe("executed\n");
          // Tool resolution must reuse the generation's complete owner, not load a second registry.
          expect(fs.readFileSync(registered, "utf8")).toBe(
            kind === "tool discovery reuse" ? "tool-discovery\nagent-runtime\n" : "agent-runtime\n",
          );
        },
      );
    } finally {
      await releaseRegistry?.();
    }
  },
);

it.each(["globally disabled", "disabled plugin", "denied plugin", "empty base"])(
  "does not revive channel policies from the root when %s",
  async (scope) => {
    const { plugin, config, workspaceDir } = createChannelFixture();
    const root = loadOpenClawPlugins({ config, workspaceDir });
    expect(root.trustedToolPolicies).toHaveLength(1);
    const scopedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        enabled: scope !== "globally disabled",
        ...(scope === "denied plugin" ? { deny: [plugin.id] } : {}),
        entries: {
          [plugin.id]: {
            enabled: scope !== "disabled plugin",
            hooks: { allowConversationAccess: true },
          },
        },
      },
    };
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: scopedConfig,
      workspaceDir,
      allowCurrent: false,
    });
    const registry = loadAgentRuntimePluginRegistryHandle({
      config: scopedConfig,
      workspaceDir,
      metadataSnapshot,
      ...(scope === "empty base" ? { basePluginIds: [] } : {}),
    });
    expect(registry.trustedToolPolicies).toHaveLength(0);
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: registry },
      async () => {
        await expect(
          runBeforeToolCallHook({
            toolName: "exec",
            params: { gate: "policy" },
            ctx: { config: scopedConfig },
          }),
        ).resolves.toMatchObject({ blocked: false });
      },
    );
  },
);

it("keeps catalog discovery inert and agent preparation non-activating", () => {
  const { plugin, config, workspaceDir, registered } = createChannelFixture();
  const catalog = loadAgentRuntimePluginRegistryHandle({
    config,
    workspaceDir,
    purpose: "model-catalog",
    basePluginIds: [plugin.id],
  });
  expect(catalog.channels.map((entry) => entry.plugin.id)).toContain(plugin.id);
  expect(fs.existsSync(registered)).toBe(false);
  const active = getActivePluginRegistry();
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
    mode: "agent-runtime",
    runtimeSideEffects: true,
  });
  expect(registry.trustedToolPolicies).toHaveLength(1);
  expect(getActivePluginRegistry()).toBe(active);
});

it("preserves tool discovery for handwritten entries that only recognize existing modes", () => {
  const { plugin, config, workspaceDir, registered } = createChannelFixture(true);
  const registry = loadAgentRuntimePluginRegistryHandle({
    config,
    workspaceDir,
    basePluginIds: [plugin.id],
  });
  const tools = resolvePluginTools({
    context: { config, workspaceDir },
    runtimeRegistry: registry,
  });
  expect(tools.map((tool) => tool.name)).toEqual(["probe_tool"]);
  expect(fs.readFileSync(registered, "utf8")).toBe("tool-discovery\n");
});
