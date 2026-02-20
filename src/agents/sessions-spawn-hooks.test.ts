import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";

const runSubagentSpawnedMock = vi.fn(async () => {});
const threadBindingMocks = vi.hoisted(() => ({
  autoBindSpawnedDiscordSubagent: vi.fn(
    async (params: unknown): Promise<Record<string, unknown> | null> => {
      const input = params as {
        accountId?: string;
        threadId?: string | number;
        childSessionKey?: string;
        agentId?: string;
      };
      return {
        accountId: input.accountId ?? "work",
        channelId: "123",
        threadId: input.threadId != null ? String(input.threadId) : "thread-1",
        targetKind: "subagent",
        targetSessionKey: input.childSessionKey ?? "agent:main:subagent:child",
        agentId: input.agentId ?? "main",
        boundBy: "system",
        boundAt: 1,
      };
    },
  ),
  unbindThreadBindingsBySessionKey: vi.fn((_params: unknown) => []),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_spawned",
    runSubagentSpawned: runSubagentSpawnedMock,
  })),
}));

vi.mock("../discord/monitor/thread-bindings.js", () => ({
  autoBindSpawnedDiscordSubagent: (params: unknown) =>
    threadBindingMocks.autoBindSpawnedDiscordSubagent(params),
  unbindThreadBindingsBySessionKey: (params: unknown) =>
    threadBindingMocks.unbindThreadBindingsBySessionKey(params),
}));

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    runSubagentSpawnedMock.mockClear();
    threadBindingMocks.autoBindSpawnedDiscordSubagent.mockClear();
    threadBindingMocks.unbindThreadBindingsBySessionKey.mockClear();
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
    expect(threadBindingMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith({
      accountId: "work",
      channel: "discord",
      to: "channel:123",
      threadId: 456,
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      agentId: "main",
      label: "research",
      boundBy: "system",
    });
    expect(runSubagentSpawnedMock).toHaveBeenCalledTimes(1);
    const [event, ctx] = (runSubagentSpawnedMock.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      runId: "run-1",
      agentId: "main",
      label: "research",
      mode: "session",
      requester: {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      threadRequested: true,
    });
    expect(event.childSessionKey).toEqual(expect.stringMatching(/^agent:main:subagent:/));
    expect(ctx).toMatchObject({
      runId: "run-1",
      requesterSessionKey: "main",
      childSessionKey: event.childSessionKey,
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
      mode: "run",
      threadRequested: false,
      requester: {
        channel: "discord",
        to: "channel:123",
      },
    });
  });

  it("respects explicit mode=run when thread binding is requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call3", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "run",
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-1", mode: "run" });
    const [event] = (runSubagentSpawnedMock.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: true,
    });
  });

  it("returns error when thread binding cannot be created", async () => {
    threadBindingMocks.autoBindSpawnedDiscordSubagent.mockResolvedValueOnce(null);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call4", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toMatch(/thread/i);
    expect(runSubagentSpawnedMock).not.toHaveBeenCalled();
    const callGatewayMock = getCallGatewayMock();
    const calledMethods = callGatewayMock.mock.calls.map((call: [unknown]) => {
      const request = call[0] as { method?: string };
      return request.method;
    });
    expect(calledMethods).toContain("sessions.delete");
    expect(calledMethods).not.toContain("agent");
  });

  it("rejects mode=session when thread=true is not requested", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call6", {
      task: "do thing",
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toMatch(/requires thread=true/i);
    expect(threadBindingMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(runSubagentSpawnedMock).not.toHaveBeenCalled();
    const callGatewayMock = getCallGatewayMock();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects thread=true on channels without thread support", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "signal",
      agentTo: "+123",
    });

    const result = await tool.execute("call5", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toMatch(/Only Discord/i);
    expect(threadBindingMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(runSubagentSpawnedMock).not.toHaveBeenCalled();
    const callGatewayMock = getCallGatewayMock();
    const calledMethods = callGatewayMock.mock.calls.map((call: [unknown]) => {
      const request = call[0] as { method?: string };
      return request.method;
    });
    expect(calledMethods).toContain("sessions.delete");
    expect(calledMethods).not.toContain("agent");
  });

  it("unbinds thread when agent start fails after successful bind", async () => {
    const callGatewayMock = getCallGatewayMock();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        throw new Error("spawn failed");
      }
      return {};
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call7", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      accountId: "work",
      targetKind: "subagent",
      reason: "spawn-failed",
      sendFarewell: true,
      farewellText: "Session failed to start. Messages here will no longer be routed.",
    });
  });
});
