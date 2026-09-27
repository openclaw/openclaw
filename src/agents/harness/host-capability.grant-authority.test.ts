import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../plugin-sdk/runtime-config-snapshot.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

const PLUGIN_A = "test-grant-alpha";
const PLUGIN_B = "test-grant-beta";
const TOOL_A = "alpha_optional_tool";
const TOOL_B = "beta_optional_tool";

let tempDir: string;
const admissions: PreparedAgentRunAdmission[] = [];

async function writeFixturePlugin(
  pluginDir: string,
  pluginId: string,
  toolName: string,
  ioSentinel: string,
): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: `${pluginId} fixture`,
        version: "0.0.0-test",
        configSchema: {},
        contracts: { tools: [toolName] },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    [
      `const toolName = ${JSON.stringify(toolName)};`,
      `const sentinel = ${JSON.stringify(ioSentinel)};`,
      "const plugin = {",
      "  register(api) {",
      "    api.registerTool(",
      "      {",
      "        name: toolName,",
      "        label: toolName,",
      "        description: toolName + ' fixture tool',",
      "        parameters: { type: 'object', properties: {} },",
      "        execute: async () => {",
      "          const fs = await import('node:fs/promises');",
      "          await fs.writeFile(sentinel, 'io-performed', 'utf8');",
      "          return { content: [{ type: 'text', text: 'grant-ok:' + toolName }], details: {} };",
      "        },",
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

async function admittedAttempt(
  runId: string,
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<HostAttempt> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-grant-authority-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId,
    cwd: path.join(tempDir, "worktree"),
    workspaceDir: path.join(tempDir, "workspace"),
    currentChannelId: "chat-1",
    messageChannel: "telegram",
    ...overrides,
    admittedRunContext,
  } as HostAttempt;
}

async function buildSurface(
  attempt: HostAttempt,
  harnessOptions: Record<string, unknown> = {},
  beforeSurface?: () => void,
) {
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const pluginConfig = {
    tools: { profile: "coding" },
    plugins: {
      enabled: true,
      load: { paths: [path.join(tempDir, "plugin-a"), path.join(tempDir, "plugin-b")] },
      entries: { [PLUGIN_A]: { enabled: true }, [PLUGIN_B]: { enabled: true } },
    },
  } as never;
  setRuntimeConfigSnapshot(pluginConfig, pluginConfig);
  return withPluginCache(createPluginCache(), () => {
    resetPluginRuntimeStateForTest();
    const fresh = loadPluginMetadataSnapshot({
      config: pluginConfig,
      workspaceDir,
      env: process.env,
    });
    setGatewayPluginMetadataSnapshot(fresh);

    const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "test-host" });
    beforeSurface?.();
    try {
      const tools = host.capabilities.createToolSurface?.({
        config: pluginConfig,
        sessionKey: attempt.sessionKey,
        workspaceDir,
        cwd: workspaceDir,
        agentDir: path.join(tempDir, "agent"),
        ...harnessOptions,
      } as never);
      return { host, tools: tools ?? [] };
    } catch (error) {
      host.close();
      throw error;
    }
  });
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-grant-"));
  await writeFixturePlugin(
    path.join(tempDir, "plugin-a"),
    PLUGIN_A,
    TOOL_A,
    path.join(tempDir, "io-a.txt"),
  );
  await writeFixturePlugin(
    path.join(tempDir, "plugin-b"),
    PLUGIN_B,
    TOOL_B,
    path.join(tempDir, "io-b.txt"),
  );
});

afterEach(async () => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("host runtime plugin tool grant authority", () => {
  it("materializes and executes the admitted grant even when harness options forge a different grant", async () => {
    const attempt = await admittedAttempt("grant-positive", {
      runtimePluginToolGrant: { pluginId: PLUGIN_A, toolNames: [TOOL_A] },
    });
    // Forged harness input: must be overwritten by the Host closure grant.
    const { host, tools } = await buildSurface(attempt, {
      runtimePluginToolGrant: { pluginId: PLUGIN_B, toolNames: [TOOL_B] },
    });
    try {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(TOOL_A);
      expect(names).not.toContain(TOOL_B);
      const toolA = tools.find((tool) => tool.name === TOOL_A);
      const result = await toolA?.execute("call-1", {});
      expect(JSON.stringify(result)).toContain(`grant-ok:${TOOL_A}`);
      expect(await fs.readFile(path.join(tempDir, "io-a.txt"), "utf8")).toBe("io-performed");
    } finally {
      host.close();
    }
  });

  it("keeps the admitted grant when shared attempt authority is mutated after host capture", async () => {
    const grant = { pluginId: PLUGIN_A, toolNames: [TOOL_A] };
    const attempt = await admittedAttempt("grant-negative", {
      runtimePluginToolGrant: grant,
    });
    const { host, tools } = await buildSurface(attempt, {}, () => {
      grant.pluginId = PLUGIN_B;
      grant.toolNames.push(TOOL_B);
      attempt.runtimePluginToolGrant = { pluginId: PLUGIN_B, toolNames: [TOOL_B] };
    });
    try {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(TOOL_A);
      expect(names).not.toContain(TOOL_B);
      // No execution path exists for the foreign tool, so its I/O sentinel
      // must be absent: denial happened before any plugin B I/O.
      await expect(fs.stat(path.join(tempDir, "io-b.txt"))).rejects.toThrow();
    } finally {
      host.close();
    }
  });

  it("does not admit optional tools without a host grant", async () => {
    const attempt = await admittedAttempt("grant-absent");
    const { host, tools } = await buildSurface(attempt, {
      runtimePluginToolGrant: { pluginId: PLUGIN_B, toolNames: [TOOL_B] },
    });
    try {
      const names = tools.map((tool) => tool.name);
      expect(names).not.toContain(TOOL_A);
      expect(names).not.toContain(TOOL_B);
    } finally {
      host.close();
    }
  });
});
