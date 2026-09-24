import "./dynamic-tool-build.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
  hoisted,
} = await import("./dynamic-tool-build.test-support.js");

const TEST_PLUGIN_ID = "test-grant-plugin";
const TEST_TOOL_NAME = "test_optional_plugin_tool";

type RuntimePluginToolGrant = {
  pluginId: string;
  toolNames: readonly string[];
};

let tempDir: string;
let hostCapabilityClosers: Array<() => void>;

function createGrant(): RuntimePluginToolGrant {
  return { pluginId: TEST_PLUGIN_ID, toolNames: [TEST_TOOL_NAME] };
}

function createGrantedParams(workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createParams(path.join(tempDir, "grant-session.jsonl"), workspaceDir);
  params.disableTools = false;
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePluginToolGrant = createGrant();
  return params;
}

async function writeGrantPlugin(pluginDir: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: TEST_PLUGIN_ID,
        name: "Grant Test Plugin",
        version: "0.0.0-test",
        configSchema: {},
        contracts: { tools: [TEST_TOOL_NAME] },
      },
      null,
      2,
    ),
    "utf8",
  );
  const toolName = JSON.stringify(TEST_TOOL_NAME);
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    [
      `const toolName = ${toolName};`,
      "const plugin = {",
      "  register(api) {",
      "    api.registerTool(",
      "      {",
      "        name: toolName,",
      "        label: toolName,",
      "        description: toolName + ' test tool',",
      "        parameters: { type: 'object', properties: {} },",
      "        execute: async () => ({",
      "          content: [{ type: 'text', text: 'grant-ok' }],",
      "          details: {},",
      "        }),",
      "      },",
      "      { name: toolName, optional: true },",
      "    );",
      "  },",
      "};",
      "module.exports = plugin;",
      "module.exports.default = plugin;",
      "",
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  hoisted.loadNodeExecAvailability.mockResolvedValue({
    cacheKey: "eligible",
    isAvailable: () => true,
  });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-grant-"));
  hostCapabilityClosers = [];
});

afterEach(async () => {
  for (const close of hostCapabilityClosers.splice(0)) {
    close();
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Codex dynamic tool build runtimePluginToolGrant", () => {
  it("forwards params.runtimePluginToolGrant into OpenClaw coding-tools options", async () => {
    const workspaceDir = path.join(tempDir, "grant-forward-workspace");
    const params = createGrantedParams(workspaceDir);
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    let captured: { runtimePluginToolGrant?: RuntimePluginToolGrant } | undefined;
    const capabilities = params.hostCapabilities;
    params.hostCapabilities = {
      ...capabilities,
      createToolSurface: ((options: unknown, binding: unknown) => {
        captured = options as typeof captured;
        return [];
      }) as typeof capabilities.createToolSurface,
    };

    await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null as never,
    });

    expect(captured?.runtimePluginToolGrant).toEqual(createGrant());
  });

  it("materializes a grant-gated optional plugin tool into the Codex catalog", async () => {
    const workspaceDir = path.join(tempDir, "grant-catalog-workspace");
    const pluginDir = path.join(tempDir, "grant-plugin");
    await writeGrantPlugin(pluginDir);

    const params = createGrantedParams(workspaceDir);
    // Explicit plugin config: without it the test harness disables all plugins.
    const pluginConfig = {
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        entries: { [TEST_PLUGIN_ID]: { enabled: true } },
      },
    } as never;
    params.config = pluginConfig;
    // The agent-tools chain resolves discovery config from the process-global
    // runtime snapshot, so publish the test config there (restored below).
    setRuntimeConfigSnapshot(pluginConfig, pluginConfig);

    const {
      loadPluginMetadataSnapshot,
      resetPluginRuntimeStateForTest,
      setGatewayPluginMetadataSnapshot,
    } = await import("openclaw/plugin-sdk/plugin-test-runtime");
    resetPluginRuntimeStateForTest();
    // Publish a freshly discovered snapshot (with load.paths) as the process
    // current snapshot, mirroring gateway boot. Without this the catalog run
    // below can adopt a stale bundled-only snapshot published earlier in the
    // worker and never discover the fixture plugin.
    const fresh = loadPluginMetadataSnapshot({
      config: pluginConfig,
      workspaceDir,
      env: process.env,
    });
    setGatewayPluginMetadataSnapshot(fresh);

    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    try {
      const tools = await buildDynamicToolsForTest(params, workspaceDir, {
        sandbox: null as never,
        nativeToolSurfaceEnabled: false,
      });
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(TEST_TOOL_NAME);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
});
