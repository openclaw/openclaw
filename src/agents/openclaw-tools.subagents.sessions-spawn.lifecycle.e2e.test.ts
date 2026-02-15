import { beforeEach, describe, expect, it } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { sleep } from "../utils.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  resetSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];
    let patchParams: { key?: string; label?: string } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.list") {
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
        const params = request.params as {
          message?: string;
          sessionKey?: string;
          lane?: string;
        };
        // Only capture the first agent call (subagent spawn, not main agent trigger)
        if (params?.lane === "subagent") {
          childRunId = runId;
          childSessionKey = params?.sessionKey ?? "";
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string; timeoutMs?: number } | undefined;
        waitCalls.push(params ?? {});
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 1000,
          endedAt: 2000,
        };
      }
      if (request.method === "sessions.patch") {
        const params = request.params as { key?: string; label?: string } | undefined;
        patchParams = { key: params?.key, label: params?.label };
        return { ok: true };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call2", {
      task: "do thing",
      runTimeoutSeconds: 1,
      label: "my-task",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    if (!childRunId) {
      throw new Error("missing child runId");
    }
    emitAgentEvent({
      runId: childRunId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1000,
        endedAt: 2000,
      },
    });

    await sleep(0);
    await sleep(0);
    await sleep(0);

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    expect(patchParams.key).toBe(childSessionKey);
    expect(patchParams.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let deletedKey: string | undefined;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as {
          message?: string;
          sessionKey?: string;
          channel?: string;
          timeout?: number;
          lane?: string;
        };
        if (params?.lane === "subagent") {
          childRunId = runId;
          childSessionKey = params?.sessionKey ?? "";
          expect(params?.channel).toBe("discord");
          expect(params?.timeout).toBe(1);
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 1000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string; timeoutMs?: number } | undefined;
        waitCalls.push(params ?? {});
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 1000,
          endedAt: 2000,
        };
      }
      if (request.method === "sessions.delete") {
        const params = request.params as { key?: string } | undefined;
        deletedKey = params?.key;
        return { ok: true };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call1", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
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
          startedAt: 1234,
          endedAt: 2345,
        },
      });

      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

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
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("discord:group:req");
    expect(second?.deliver).toBe(true);
    expect(second?.message).toContain("subagent task");

    const sendCalls = calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let deletedKey: string | undefined;
    let childRunId: string | undefined;
    let childSessionKey: string | undefined;
    const waitCalls: Array<{ runId?: string; timeoutMs?: number }> = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as {
          message?: string;
          sessionKey?: string;
          channel?: string;
          timeout?: number;
          lane?: string;
        };
        // Only capture the first agent call (subagent spawn, not main agent trigger)
        if (params?.lane === "subagent") {
          childRunId = runId;
          childSessionKey = params?.sessionKey ?? "";
          expect(params?.channel).toBe("discord");
          expect(params?.timeout).toBe(1);
        }
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string; timeoutMs?: number } | undefined;
        waitCalls.push(params ?? {});
        return {
          runId: params?.runId ?? "run-1",
          status: "ok",
          startedAt: 3000,
          endedAt: 4000,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        const params = request.params as { key?: string } | undefined;
        deletedKey = params?.key;
        return { ok: true };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call1b", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "delete",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    await sleep(0);
    await sleep(0);
    await sleep(0);

    const childWait = waitCalls.find((call) => call.runId === childRunId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(childSessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("discord:group:req");
    expect(second?.deliver).toBe(true);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

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

    const tool = createOpenClawTools({
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-timeout", {
      task: "do thing",
      runTimeoutSeconds: 1,
      cleanup: "keep",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });

    await sleep(0);
    await sleep(0);
    await sleep(0);

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

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

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
