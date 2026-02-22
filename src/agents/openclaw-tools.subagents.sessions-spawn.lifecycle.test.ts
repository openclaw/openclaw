import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: () => false,
  isEmbeddedPiRunStreaming: () => false,
  queueEmbeddedPiMessage: () => false,
  waitForEmbeddedPiRunEnd: async () => true,
}));

const callGatewayMock = getCallGatewayMock();
const RUN_TIMEOUT_SECONDS = 1;

function buildDiscordCleanupHooks(onDelete: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      onDelete(rec?.key);
    },
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_500) => {
  await vi.waitFor(
    () => {
      expect(predicate()).toBe(true);
    },
    { timeout: timeoutMs, interval: 8 },
  );
};

async function getDiscordGroupSpawnTool() {
  return await getSessionsSpawnTool({
    agentSessionKey: "discord:group:req",
    agentChannel: "discord",
  });
}

async function executeSpawnAndExpectAccepted(params: {
  tool: Awaited<ReturnType<typeof getSessionsSpawnTool>>;
  callId: string;
  cleanup?: "delete" | "keep";
  label?: string;
}) {
  const result = await params.tool.execute(params.callId, {
    task: "do thing",
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    ...(params.label ? { label: params.label } : {}),
  });
  expect(result.details).toMatchObject({
    status: "accepted",
    runId: "run-1",
  });
  return result;
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    if (previousFastTestEnv === undefined) {
      previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          debounceMs: 0,
        },
      },
    });
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  afterAll(() => {
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
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
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call2",
      label: "my-task",
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
    await waitFor(() => ctx.calls.filter((c) => c.method === "agent").length >= 2);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("agent:main:main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1",
      cleanup: "delete",
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

    await waitFor(() => ctx.calls.filter((call) => call.method === "agent").length >= 2);
    await waitFor(() => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
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
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(true);
    expect(second?.message).toContain("subagent task");

    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1b",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(() => ctx.waitCalls.some((call) => call.runId === child.runId));
    await waitFor(() => ctx.calls.filter((call) => call.method === "agent").length >= 2);
    await waitFor(() => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(true);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn reports timed out when agent.wait returns timeout", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-timeout",
      cleanup: "keep",
    });

    await waitFor(() => ctx.calls.filter((call) => call.method === "agent").length >= 2);

    const mainAgentCall = ctx.calls
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
    const ctx = setupSessionsSpawnGatewayMock({});

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-announce-account",
      cleanup: "keep",
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
          startedAt: 1000,
          endedAt: 2000,
        },
      });

      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(true);
    expect(announceParams?.channel).toBe("whatsapp");
    expect(announceParams?.accountId).toBe("kev");
  });
});
