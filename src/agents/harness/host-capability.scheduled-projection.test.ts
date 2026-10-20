import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createCronScheduledToolProjection,
  readCronScheduledToolProjection,
} from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { resolveAgentHarnessScheduledToolProjectionCapability } from "./host-private-capabilities.js";

let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
const projection = {
  kind: "exec",
  name: "gateway_exec",
  description: "Gateway exec",
  followupText: "Use gateway_process for follow-up.",
} as const;
afterEach(() => {
  host?.closeHost();
  host?.closeAdmission();
  host = undefined;
  resetAgentRunRegistryForTest();
  clearRuntimeConfigSnapshot();
});

it("issues scheduled shell projections only from this host-created tool surface", async () => {
  setRuntimeConfigSnapshot({});
  host = await createAdmittedHostCapabilityTestFixture({
    runId: "run-scheduled-tool-projection",
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
    currentChannelId: "chat-1",
    messageChannel: "telegram",
  });
  const { hostCapabilities, closeHost } = host;
  const resolveProjection = (ownerPluginId: string) =>
    resolveAgentHarnessScheduledToolProjectionCapability({
      hostCapabilities,
      ownerPluginId,
    });
  expect(resolveProjection("other-harness")).toBeUndefined();
  const sourceTools = (await hostCapabilities.createToolSurfaceAsync?.({})) ?? [];
  const execTool = sourceTools.find((tool) => tool.name === "exec");
  const createProjection = resolveProjection("codex");
  if (!execTool || !createProjection) {
    throw new Error("expected host-created exec projection test surface");
  }
  const alias = createProjection(execTool, projection);
  expect(readCronScheduledToolProjection(alias)).toEqual({
    targetTool: "exec",
    execTarget: { host: "gateway" },
  });

  expect(readCronScheduledToolProjection({ ...alias })).toBeUndefined();
  const expectRejectedSource = (source: AnyAgentTool) =>
    expect(() => createProjection(source, projection)).toThrow(
      "was not created by this host capability",
    );

  const renamedAlias = { ...alias };
  Object.assign(alias, { execute: async () => ({ content: [], details: {} }) });
  expect(() => readCronScheduledToolProjection(alias)).toThrow("changed after host creation");
  Object.assign(alias, { execute: renamedAlias.execute });

  const forgedExecute = async () => ({ content: [], details: {} });
  const sourceExecute = execTool.execute;
  execTool.execute = forgedExecute;
  expectRejectedSource(execTool);
  execTool.execute = sourceExecute;

  const pluginExec = { ...execTool, name: "exec" };
  const [boundPluginExec] = hostCapabilities.bindToolSurface([pluginExec]);
  expectRejectedSource(boundPluginExec!);

  const nonShellTool = sourceTools.find((tool) => tool.name !== "exec" && tool.name !== "process");
  if (!nonShellTool) {
    throw new Error("expected a non-shell host-created tool");
  }
  nonShellTool.name = "exec";
  expectRejectedSource(nonShellTool);

  closeHost();
  expect(() => readCronScheduledToolProjection(alias)).toThrow();
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
    ...projection,
    ask: "always",
  });

  const result = await alias.execute("call-1", {
    command: "echo safe",
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
