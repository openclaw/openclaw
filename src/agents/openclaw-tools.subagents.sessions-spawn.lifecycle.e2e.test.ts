import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  resetSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  isEmbeddedPiRunStreaming: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

const callGatewayMock = getCallGatewayMock();

type CreateOpenClawTools = (typeof import("./openclaw-tools.js"))["createOpenClawTools"];
type CreateOpenClawToolsOpts = Parameters<CreateOpenClawTools>[0];

async function getSessionsSpawnTool(opts: CreateOpenClawToolsOpts) {
  // Dynamic import: ensure harness mocks are installed before tool modules load.
  const { createOpenClawTools } = await import("./openclaw-tools.js");
  const tool = createOpenClawTools(opts).find((candidate) => candidate.name === "sessions_spawn");
  if (!tool) {
    throw new Error("missing sessions_spawn tool");
  }
  return tool;
}

type GatewayRequest = { method?: string; params?: unknown };
type AgentWaitCall = { runId?: string; timeoutMs?: number };

function setupSessionsSpawnGatewayMock(opts: {
  includeSessionsList?: boolean;
  includeChatHistory?: boolean;
  onAgentSubagentSpawn?: (params: unknown) => void;
  onSessionsPatch?: (params: unknown) => void;
  onSessionsDelete?: (params: unknown) => void;
  agentWaitResult?: { status: "ok" | "timeout"; startedAt: number; endedAt: number };
}): {
  calls: Array<GatewayRequest>;
  waitCalls: Array<AgentWaitCall>;
  getChild: () => { runId?: string; sessionKey?: string };
} {
  const calls: Array<GatewayRequest> = [];
  const waitCalls: Array<AgentWaitCall> = [];
  let agentCallCount = 0;
  let childRunId: string | undefined;
  let childSessionKey: string | undefined;

  callGatewayMock.mockImplementation(async (optsUnknown: unknown) => {
    const request = optsUnknown as GatewayRequest;
    calls.push(request);

    if (request.method === "sessions.list" && opts.includeSessionsList) {
      return {
        sessions: [
          {
            key: "main",
            lastChannel: "whatsapp",
            lastTo: "+123",
          },
        ],
      };
    }

    if (request.method === "agent") {
      agentCallCount += 1;
      const runId = `run-${agentCallCount}`;
      const params = request.params as { lane?: string; sessionKey?: string } | undefined;
      // Only capture the first agent call (subagent spawn, not main agent trigger)
      if (params?.lane === "subagent") {
        childRunId = runId;
        childSessionKey = params?.sessionKey ?? "";
        opts.onAgentSubagentSpawn?.(params);
      }
      return {
        runId,
        status: "accepted",
        acceptedAt: 1000 + agentCallCount,
      };
    }

    if (request.method === "agent.wait") {
      const params = request.params as AgentWaitCall | undefined;
      waitCalls.push(params ?? {});
      const res = opts.agentWaitResult ?? { status: "ok", startedAt: 1000, endedAt: 2000 };
      return {
        runId: params?.runId ?? "run-1",
        ...res,
      };
    }

    if (request.method === "sessions.patch") {
      opts.onSessionsPatch?.(request.params);
      return { ok: true };
    }

    if (request.method === "sessions.delete") {
      opts.onSessionsDelete?.(request.params);
      return { ok: true };
    }

    if (request.method === "chat.history" && opts.includeChatHistory) {
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      };
    }

    return {};
  });

  return {
    calls,
    waitCalls,
    getChild: () => ({ runId: childRunId, sessionKey: childSessionKey }),
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  await vi.waitFor(
    () => {
      expect(predicate()).toBe(true);
    },
    { timeout: timeoutMs, interval: 10 },
  );
};

function expectSingleCompletionSend(
  calls: GatewayRequest[],
  expected: { sessionKey: string; channel: string; to: string; message: string },
) {
  const sendCalls = calls.filter((call) => call.method === "send");
  expect(sendCalls).toHaveLength(1);
  const send = sendCalls[0]?.params as
    | { sessionKey?: string; channel?: string; to?: string; message?: string }
    | undefined;
  expect(send?.sessionKey).toBe(expected.sessionKey);
  expect(send?.channel).toBe(expected.channel);
  expect(send?.to).toBe(expected.to);
  expect(send?.message).toBe(expected.message);
}

function createDeleteCleanupHooks(setDeletedKey: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      setDeletedKey(rec?.key);
    },
  };
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const patchCalls: Array<{ key?: string; label?: string }> = [];

    const ctx = setupSessionsSpawnGatewayMock({
      includeSessionsList: true,
      includeChatHistory: true,
      onSessionsPatch: (params) => {
        const rec = params as { key?: string; label?: string } | undefined;
        patchCalls.push({ key: rec?.key, label: rec?.label });
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentTo: "+123",
    });

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
      label: "my-task",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    emitAgentEvent({
      runId: child.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1000,
        endedAt: 2000,
      },
    });

    await waitFor(() => ctx.waitCalls.some((call) => call.runId === child.runId));
    await waitFor(() => patchCalls.some((call) => call.label === "my-task"));
    await waitFor(() => ctx.calls.filter((c) => c.method === "send").length >= 1);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Subagent spawn call plus direct outbound completion send.
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(1);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Direct send should route completion to the requester channel/session.
    expectSingleCompletionSend(ctx.calls, {
      sessionKey: "agent:main:main",
      channel: "whatsapp",
      to: "+123",
      message: "✅ Subagent main finished\n\ndone",
    });
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...createDeleteCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
      agentTo: "discord:dm:u123",
    });

    const result = await tool.execute("call1", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    vi.useFakeTimers();
    try {
      emitAgentEvent({
        runId: child.runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 1234,
          endedAt: 2345,
        },
      });

      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);

    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    expectSingleCompletionSend(ctx.calls, {
      sessionKey: "agent:main:discord:group:req",
      channel: "discord",
      to: "discord:dm:u123",
      message: "✅ Subagent main finished",
    });

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...createDeleteCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
      agentTo: "discord:dm:u123",
    });

    const result = await tool.execute("call1b", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(() => ctx.waitCalls.some((call) => call.runId === child.runId));
    await waitFor(() => ctx.calls.filter((call) => call.method === "send").length >= 1);
    await waitFor(() => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // One agent call for spawn, then direct completion send.
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    expectSingleCompletionSend(ctx.calls, {
      sessionKey: "agent:main:discord:group:req",
      channel: "discord",
      to: "discord:dm:u123",
      message: "✅ Subagent main finished\n\ndone",
    });

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn reports timed out when agent.wait returns timeout", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        return {
          runId: `run-${agentCallCount}`,
          status: "accepted",
          acceptedAt: 5000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        return {
          runId: params?.runId ?? "run-1",
          status: "timeout",
          startedAt: 6000,
          endedAt: 7000,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "still working" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-timeout", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "keep",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    await waitFor(() => calls.filter((call) => call.method === "agent").length >= 2);

    const mainAgentCall = calls
      .filter((call) => call.method === "agent")
      .find((call) => {
        const params = call.params as { lane?: string } | undefined;
        return params?.lane !== "subagent";
      });
    const mainMessage = (mainAgentCall?.params as { message?: string } | undefined)?.message ?? "";

    expect(mainMessage).toContain("timed out");
    expect(mainMessage).not.toContain("completed successfully");
  });

  it("sessions_spawn announces with requester accountId", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let childRunId: string | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { lane?: string; sessionKey?: string } | undefined;
        if (params?.lane === "subagent") {
          childRunId = runId;
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 4000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string; timeoutMs?: number } | undefined;
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 1000,
          endedAt: 2000,
        };
      }
      if (request.method === "sessions.delete" || request.method === "sessions.patch") {
        return { ok: true };
      }
      return {};
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    });

    const result = await tool.execute("call-announce-account", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "keep",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    if (!childRunId) {
      throw new Error("missing child runId");
    }
    vi.useFakeTimers();
    try {
      emitAgentEvent({
        runId: childRunId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 1000,
          endedAt: 2000,
        },
      });

      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(true);
    expect(announceParams?.channel).toBe("whatsapp");
    expect(announceParams?.accountId).toBe("kev");
  });
});
