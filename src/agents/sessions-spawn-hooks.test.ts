import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  findGatewayRequest,
  getCallGatewayMock,
  getGatewayMethods,
  getSessionsSpawnTool,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
      requester?: { channel?: string };
    };
    if (!input.threadRequested) {
      return undefined;
    }
    const channel = input.requester?.channel?.trim().toLowerCase();
    if (channel !== "discord") {
      const channelLabel = input.requester?.channel?.trim() || "unknown";
      return {
        status: "error" as const,
        error: `thread=true is not supported for channel "${channelLabel}". Only Discord thread-bound subagent sessions are supported right now.`,
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) =>
      hookName === "subagent_spawning" ||
      hookName === "subagent_spawned" ||
      (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
    runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
    runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
    runSubagentEnded: hookRunnerMocks.runSubagentEnded,
  })),
}));

function expectSessionsDeleteWithoutAgentStart() {
  const methods = getGatewayMethods();
  expect(methods).toContain("sessions.delete");
  expect(methods).not.toContain("agent");
}

function mockAgentStartFailure() {
  const callGatewayMock = getCallGatewayMock();
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    const callGatewayMock = getCallGatewayMock();
    callGatewayMock.mockClear();
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

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("runs subagent_spawning and emits subagent_spawned with requester metadata", async () => {
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
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledWith(
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
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
      },
      {
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
        requesterSessionKey: "main",
      },
    );

    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
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
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
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
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentSpawned.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      mode: "run",
      threadRequested: true,
    });
  });

  it("returns error when thread binding cannot be created", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "error",
      error: "Unable to create or bind a Discord thread for this subagent session.",
    });
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
    const details = result.details as { error?: string; childSessionKey?: string };
    expect(details.error).toMatch(/thread/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: details.childSessionKey,
      emitLifecycleHooks: false,
    });
  });

  it("returns error when thread binding is not marked ready", async () => {
    hookRunnerMocks.runSubagentSpawning.mockResolvedValueOnce({
      status: "ok",
      threadBindingReady: false,
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call4b", {
      task: "do thing",
      runTimeoutSeconds: 1,
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    const details = result.details as { error?: string; childSessionKey?: string };
    expect(details.error).toMatch(/unable to create or bind a thread/i);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: details.childSessionKey,
      emitLifecycleHooks: false,
    });
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
    expect(hookRunnerMocks.runSubagentSpawning).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
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
    expect(details.error).toMatch(/only discord/i);
    expect(hookRunnerMocks.runSubagentSpawning).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
    expectSessionsDeleteWithoutAgentStart();
  });

  it("runs subagent_ended cleanup hook when agent start fails after successful bind", async () => {
    mockAgentStartFailure();
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
    expect(hookRunnerMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    const [event] = (hookRunnerMocks.runSubagentEnded.mock.calls[0] ?? []) as unknown as [
      Record<string, unknown>,
    ];
    expect(event).toMatchObject({
      targetSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      accountId: "work",
      targetKind: "subagent",
      reason: "spawn-failed",
      sendFarewell: true,
      outcome: "error",
      error: "Session failed to start",
    });
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      key: event.targetSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it("falls back to sessions.delete cleanup when subagent_ended hook is unavailable", async () => {
    hookRunnerMocks.hasSubagentEndedHook = false;
    mockAgentStartFailure();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "discord",
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call8", {
      task: "do thing",
      thread: true,
      mode: "session",
    });

    expect(result.details).toMatchObject({ status: "error" });
    expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
    const methods = getGatewayMethods();
    expect(methods).toContain("sessions.delete");
    const deleteCall = findGatewayRequest("sessions.delete");
    expect(deleteCall?.params).toMatchObject({
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });
});
