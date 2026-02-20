import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";

const runSubagentSpawnedMock = vi.fn(async () => {});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_spawned",
    runSubagentSpawned: runSubagentSpawnedMock,
  })),
}));

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    runSubagentSpawnedMock.mockClear();
    const callGatewayMock = getCallGatewayMock();
    callGatewayMock.mockReset();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-1", status: "running" };
      }
      return {};
    });
  });

  it("emits subagent_spawned with requester metadata and threadRequested=true", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
    });

    const result = await tool.execute("call", {
      task: "do thing",
      label: "research",
      runTimeoutSeconds: 1,
      thread: true,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(runSubagentSpawnedMock).toHaveBeenCalledTimes(1);
    const [event, ctx] = (runSubagentSpawnedMock.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      runId: "run-1",
      agentId: "main",
      label: "research",
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      threadRequested: true,
    });
    expect(event.targetSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
    expect(ctx).toMatchObject({
      runId: "run-1",
      requesterSessionKey: "main",
      targetSessionKey: event.targetSessionKey,
    });
  });

  it("emits subagent_spawned with threadRequested=false when not requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(runSubagentSpawnedMock).toHaveBeenCalledTimes(1);
    const [event] = (runSubagentSpawnedMock.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      threadRequested: false,
      requester: {
        channel: "discord",
        to: "channel:123",
      },
    });
  });
});
