import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createCronScheduledToolProjection,
  readCronScheduledToolProjection,
} from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { resolveAgentHarnessScheduledToolProjectionCapability } from "./host-private-capabilities.js";

const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
async function createHost(runId: string) {
  const host = await createAdmittedHostCapabilityTestFixture({
    runId,
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
    currentChannelId: "chat-1",
    messageChannel: "telegram",
  });
  hosts.push(host);
  return host;
}
afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.closeHost();
    host.closeAdmission();
  }
  resetAgentRunRegistryForTest();
});

describe("agent harness scheduled tool projection", () => {
  it("issues scheduled shell projections only from this host-created tool surface", async () => {
    const host = await createHost("run-scheduled-tool-projection");
    const sourceTools = (await host.hostCapabilities.createToolSurfaceAsync?.({})) ?? [];
    const execTool = sourceTools.find((tool) => tool.name === "exec");
    const createProjection = resolveAgentHarnessScheduledToolProjectionCapability({
      hostCapabilities: host.hostCapabilities,
      ownerPluginId: "codex",
    });
    if (!execTool || !createProjection) {
      throw new Error("expected host-created exec projection test surface");
    }
    const projection = {
      kind: "exec" as const,
      name: "gateway_exec",
      description: "Gateway exec",
      followupText: "Use gateway_process for follow-up.",
    };
    const alias = createProjection(execTool, projection);
    expect(readCronScheduledToolProjection(alias)).toEqual({
      targetTool: "exec",
      execTarget: { host: "gateway" },
    });

    // A shallow same-name copy is a different object: no projection identity.
    expect(readCronScheduledToolProjection({ ...alias })).toBeUndefined();

    // Swapping the alias executable after host creation is a tamper signal.
    const renamedAlias = { ...alias };
    Object.assign(alias, { execute: async () => ({ content: [], details: {} }) });
    expect(() => readCronScheduledToolProjection(alias)).toThrow("changed after host creation");
    Object.assign(alias, { execute: renamedAlias.execute });

    // A source whose executable was swapped is not the host-created shell tool.
    const forgedExecute = async () => ({ content: [], details: {} });
    const sourceExecute = execTool.execute;
    execTool.execute = forgedExecute;
    expect(() => createProjection(execTool, projection)).toThrow(
      "was not created by this host capability",
    );
    execTool.execute = sourceExecute;

    // A plugin-bound copy of exec is not the host-created source object.
    const pluginExec = { ...execTool, name: "exec" };
    const [boundPluginExec] = host.hostCapabilities.bindToolSurface([pluginExec]);
    expect(() => createProjection(boundPluginExec!, projection)).toThrow(
      "was not created by this host capability",
    );

    // A non-shell host tool renamed to exec never gains shell projection rights.
    const nonShellTool = sourceTools.find(
      (tool) => tool.name !== "exec" && tool.name !== "process",
    );
    if (!nonShellTool) {
      throw new Error("expected a non-shell host-created tool");
    }
    nonShellTool.name = "exec";
    expect(() => createProjection(nonShellTool, projection)).toThrow(
      "was not created by this host capability",
    );

    host.closeHost();
    expect(() => readCronScheduledToolProjection(alias)).toThrow();
  });

  it("keeps scheduled shell issuance private to the registered owner plugin", async () => {
    const host = await createHost("run-projection-owner");

    expect(
      resolveAgentHarnessScheduledToolProjectionCapability({
        hostCapabilities: host.hostCapabilities,
        ownerPluginId: "other-harness",
      }),
    ).toBeUndefined();
    host.closeHost();
  });

  it("constructs scheduled exec projections with host-owned policy", async () => {
    const execute = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: "Command still running. Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
        },
      ],
      details: {},
    }));
    const source = {
      name: "exec",
      label: "Exec",
      description: "exec",
      parameters: Type.Object({}),
      execute,
    } satisfies AnyAgentTool;
    const alias = createCronScheduledToolProjection(source, () => {}, "exec", {
      kind: "exec",
      name: "gateway_exec",
      description: "Gateway exec",
      followupText: "Use gateway_process for follow-up.",
      ask: "always",
    });

    const result = await alias.execute("call-1", {
      command: "echo safe",
      host: "node",
      node: "remote",
      security: "full",
      ask: "off",
    });

    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { command: "echo safe", host: "gateway", ask: "always" },
      undefined,
      undefined,
    );
    expect(readCronScheduledToolProjection(alias)).toEqual({
      targetTool: "exec",
      execTarget: { host: "gateway", ask: "always" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Command still running. Use gateway_process for follow-up." },
    ]);
  });
});
