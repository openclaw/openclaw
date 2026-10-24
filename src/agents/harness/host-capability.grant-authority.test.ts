import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const PLUGIN_A = "test-grant-alpha";
const PLUGIN_B = "test-grant-beta";
const TOOL_A = "alpha_optional_tool";
const TOOL_B = "beta_optional_tool";
const grantB = () => ({ pluginId: PLUGIN_B, toolNames: [TOOL_B] });
let tempDir: string;
const cleanups: Array<() => void> = [];
const ioPath = (suffix: string) => path.join(tempDir, `io-${suffix}.txt`);

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
      JSON.stringify({ id: pluginId, configSchema: {}, contracts: { tools: [toolName] } }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `
      const toolName = ${JSON.stringify(toolName)};
      module.exports = { register(api) {
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
    `,
    );
  }
});

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    close();
  }
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function createSurface(scenario: "forged options" | "mutated attempt" | "absent grant") {
  const grant = { pluginId: PLUGIN_A, toolNames: [TOOL_A] };
  const workspaceDir = path.join(tempDir, "workspace");
  const config: OpenClawConfig = {
    tools: { profile: "coding" },
    plugins: {
      enabled: true,
      load: { paths: [path.join(tempDir, "plugin-a"), path.join(tempDir, "plugin-b")] },
      entries: { [PLUGIN_A]: { enabled: true }, [PLUGIN_B]: { enabled: true } },
    },
  };
  await fs.mkdir(workspaceDir, { recursive: true });
  setRuntimeConfigSnapshot(config, config);
  return withPluginCache(createPluginCache(), async () => {
    resetPluginRuntimeStateForTest();
    setGatewayPluginMetadataSnapshot(
      loadPluginMetadataSnapshot({ config, workspaceDir, env: process.env }),
    );
    const { attempt, hostCapabilities, closeHost, closeAdmission } =
      await createAdmittedHostCapabilityTestFixture({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "host-grant-authority",
        cwd: path.join(tempDir, "worktree"),
        workspaceDir,
        currentChannelId: "chat-1",
        messageChannel: "telegram",
        runtimePluginToolGrant: scenario === "absent grant" ? undefined : grant,
      });
    cleanups.push(closeAdmission, closeHost);
    if (scenario === "mutated attempt") {
      grant.pluginId = PLUGIN_B;
      grant.toolNames.push(TOOL_B);
      attempt.runtimePluginToolGrant = grantB();
    }
    return (
      hostCapabilities.createToolSurface?.({
        config,
        sessionKey: attempt.sessionKey,
        workspaceDir,
        cwd: workspaceDir,
        agentDir: path.join(tempDir, "agent"),
        ...(scenario === "mutated attempt" ? {} : { runtimePluginToolGrant: grantB() }),
      }) ?? []
    );
  });
}

it.each(["forged options", "mutated attempt", "absent grant"] as const)(
  "keeps optional tools bound to the captured host grant with %s",
  async (scenario) => {
    const tools = await createSurface(scenario);
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain(TOOL_B);
    if (scenario === "absent grant") {
      expect(names).not.toContain(TOOL_A);
    } else {
      expect(names).toContain(TOOL_A);
      if (scenario === "forged options") {
        const result = await tools.find((tool) => tool.name === TOOL_A)?.execute("call-1", {});
        expect(JSON.stringify(result)).toContain(`grant-ok:${TOOL_A}`);
        expect(await fs.readFile(ioPath("a"), "utf8")).toBe("io-performed");
      } else {
        await expect(fs.stat(ioPath("b"))).rejects.toThrow();
      }
    }
  },
);
