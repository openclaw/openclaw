import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
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
} from "../admitted-run-context.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];
const PLUGIN_A = "test-grant-alpha";
const PLUGIN_B = "test-grant-beta";
const TOOL_A = "alpha_optional_tool";
const TOOL_B = "beta_optional_tool";
const grantA = () => ({ pluginId: PLUGIN_A, toolNames: [TOOL_A] });
const grantB = () => ({ pluginId: PLUGIN_B, toolNames: [TOOL_B] });
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-grant-"));
  for (const [suffix, pluginId, toolName] of [
    ["a", PLUGIN_A, TOOL_A],
    ["b", PLUGIN_B, TOOL_B],
  ]) {
    const pluginDir = path.join(tempDir, `plugin-${suffix}`);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        name: `${pluginId} fixture`,
        version: "0.0.0-test",
        configSchema: {},
        contracts: { tools: [toolName] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `
      const toolName = ${JSON.stringify(toolName)};
      const plugin = { register(api) {
        api.registerTool({
          name: toolName, label: toolName, description: toolName + ' fixture tool',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            const fs = await import('node:fs/promises');
            await fs.writeFile(${JSON.stringify(path.join(tempDir, `io-${suffix}.txt`))}, 'io-performed', 'utf8');
            return { content: [{ type: 'text', text: 'grant-ok:' + toolName }], details: {} };
          },
        }, { name: toolName, optional: true });
      }};
      module.exports = plugin;
      module.exports.default = plugin;
    `,
    );
  }
});

afterEach(async () => {
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function withSurface(
  grant: HostAttempt["runtimePluginToolGrant"],
  harnessOptions: Record<string, unknown>,
  check: (tools: AnyAgentTool[]) => Promise<void> | void,
  afterCapture?: (attempt: HostAttempt) => void,
) {
  const runId = "host-grant-authority";
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-grant-authority-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  const workspaceDir = path.join(tempDir, "workspace");
  const config: OpenClawConfig = {
    tools: { profile: "coding" },
    plugins: {
      enabled: true,
      load: { paths: [path.join(tempDir, "plugin-a"), path.join(tempDir, "plugin-b")] },
      entries: { [PLUGIN_A]: { enabled: true }, [PLUGIN_B]: { enabled: true } },
    },
  };
  let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
  try {
    const attempt: HostAttempt = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: path.join(tempDir, "worktree"),
      workspaceDir,
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      runtimePluginToolGrant: grant,
      admittedRunContext: await admission.admit("plugin-harness", `harness-${runId}`),
    };
    await fs.mkdir(workspaceDir, { recursive: true });
    setRuntimeConfigSnapshot(config, config);
    const tools = withPluginCache(createPluginCache(), () => {
      resetPluginRuntimeStateForTest();
      setGatewayPluginMetadataSnapshot(
        loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env }),
      );
      host = createAgentHarnessHostCapabilities({ attempt, pluginId: "test-host" });
      afterCapture?.(attempt);
      return (
        host.capabilities.createToolSurface?.({
          config,
          sessionKey: attempt.sessionKey,
          workspaceDir,
          cwd: workspaceDir,
          agentDir: path.join(tempDir, "agent"),
          ...harnessOptions,
        }) ?? []
      );
    });
    await check(tools);
  } finally {
    host?.close();
    admission.close();
  }
}

describe("host runtime plugin tool grant authority", () => {
  it("materializes and executes the admitted grant even when harness options forge a different grant", async () => {
    await withSurface(grantA(), { runtimePluginToolGrant: grantB() }, async (tools) => {
      expect(tools.map((tool) => tool.name)).toContain(TOOL_A);
      expect(tools.map((tool) => tool.name)).not.toContain(TOOL_B);
      const result = await tools.find((tool) => tool.name === TOOL_A)?.execute("call-1", {});
      expect(JSON.stringify(result)).toContain(`grant-ok:${TOOL_A}`);
      expect(await fs.readFile(path.join(tempDir, "io-a.txt"), "utf8")).toBe("io-performed");
    });
  });

  it("keeps the admitted grant when shared attempt authority is mutated after host capture", async () => {
    const grant = grantA();
    await withSurface(
      grant,
      {},
      async (tools) => {
        expect(tools.map((tool) => tool.name)).toContain(TOOL_A);
        expect(tools.map((tool) => tool.name)).not.toContain(TOOL_B);
        await expect(fs.stat(path.join(tempDir, "io-b.txt"))).rejects.toThrow();
      },
      (attempt) => {
        grant.pluginId = PLUGIN_B;
        grant.toolNames.push(TOOL_B);
        attempt.runtimePluginToolGrant = grantB();
      },
    );
  });

  it("does not admit optional tools without a host grant", async () => {
    await withSurface(undefined, { runtimePluginToolGrant: grantB() }, (tools) => {
      expect(tools.map((tool) => tool.name)).not.toContain(TOOL_A);
      expect(tools.map((tool) => tool.name)).not.toContain(TOOL_B);
    });
  });
});
