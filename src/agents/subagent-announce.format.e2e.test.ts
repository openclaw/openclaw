import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const readLatestAssistantReplyMock = vi.fn(
  async (_sessionKey?: string): Promise<string | undefined> => "raw subagent reply",
);
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const subagentRegistryMock = {
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn((_sessionKey: string) => 0),
  resolveRequesterForChildSession: vi.fn((_sessionKey: string): RequesterResolution => null),
};
const chatHistoryMock = vi.fn(async (_sessionKey?: string) => ({
  messages: [] as Array<unknown>,
}));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
const defaultOutcomeAnnounce = {
  task: "do thing",
  timeoutMs: 1000,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" } as const,
};

async function getSingleAgentCallParams() {
  await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
  const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
  return call?.params ?? {};
}

function loadSessionStoreFixture(): Record<string, Record<string, unknown>> {
  return new Proxy(sessionStore, {
    get(target, key: string | symbol) {
      if (typeof key === "string" && !(key in target) && key.includes(":subagent:")) {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      }
      return target[key as keyof typeof target];
    },
  });
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey);
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => loadSessionStoreFixture()),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("./subagent-registry.js", () => subagentRegistryMock);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("subagent announce formatting", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    sendSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    subagentRegistryMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    subagentRegistryMock.countActiveDescendantRuns.mockReset().mockReturnValue(0);
    subagentRegistryMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("sends instructional message to main agent with status and findings", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-123",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-123",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: true,
      startedAt: 10,
      endedAt: 20,
    });

    expect(agentSpy).toHaveBeenCalled();
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: { message?: string; sessionKey?: string };
    };
    const msg = call?.params?.message as string;
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(msg).toContain("[System Message]");
    expect(msg).toContain("[sessionId: child-session-123]");
    expect(msg).toContain("subagent task");
    expect(msg).toContain("failed");
    expect(msg).toContain("boom");
    expect(msg).toContain("Result:");
    expect(msg).toContain("raw subagent reply");
    expect(msg).toContain("Stats:");
    expect(msg).toContain("A completed subagent task is ready for user delivery.");
    expect(msg).toContain("Convert the result above into your normal assistant voice");
    expect(msg).toContain("Keep this internal context private");
  });

  it("includes success status when outcome is ok", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    // Use waitForCompletion: false so it uses the provided outcome instead of calling agent.wait
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("completed successfully");
  });

  it("uses child-run announce identity for direct idempotency", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-direct-idem",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.idempotencyKey).toBe(
      "announce:v1:agent:main:subagent:worker:run-direct-idem",
    );
  });

  it.each([
    { role: "toolResult", toolOutput: "tool output line 1", childRunId: "run-tool-fallback-1" },
    { role: "tool", toolOutput: "tool output line 2", childRunId: "run-tool-fallback-2" },
  ] as const)(
    "falls back to latest $role output when assistant reply is empty",
    async (testCase) => {
      const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
      chatHistoryMock.mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
          {
            role: testCase.role,
            content: [{ type: "text", text: testCase.toolOutput }],
          },
        ],
      });
      readLatestAssistantReplyMock.mockResolvedValue("");

      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: testCase.childRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        ...defaultOutcomeAnnounce,
        waitForCompletion: false,
      });

      const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
      const msg = call?.params?.message as string;
      expect(msg).toContain(testCase.toolOutput);
    },
  );

  it("uses latest assistant text when it appears after a tool output", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "tool",
          content: [{ type: "text", text: "tool output line" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant final line" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-latest-assistant",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
      waitForCompletion: false,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("assistant final line");
  });

  it("keeps full findings and includes compact stats", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-usage",
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
      },
    };
    readLatestAssistantReplyMock.mockResolvedValue(
      Array.from({ length: 140 }, (_, index) => `step-${index}`).join(" "),
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("Result:");
    expect(msg).toContain("Stats:");
    expect(msg).toContain("tokens 1.0k (in 12 / out 1.0k)");
    expect(msg).toContain("prompt/cache 197.0k");
    expect(msg).toContain("[sessionId: child-session-usage]");
    expect(msg).toContain("A completed subagent task is ready for user delivery.");
    expect(msg).toContain(
      `Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`,
    );
    expect(msg).toContain("step-0");
    expect(msg).toContain("step-139");
  });

  it("sends deterministic completion message directly for manual spawn completion", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct",
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
      },
      "agent:main:main": {
        sessionId: "requester-session",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "final answer: 2" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-completion",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    const rawMessage = call?.params?.message;
    const msg = typeof rawMessage === "string" ? rawMessage : "";
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(msg).toContain("✅ Subagent main finished");
    expect(msg).toContain("final answer: 2");
    expect(msg).not.toContain("Convert the result above into your normal assistant voice");
  });

  it("ignores stale session thread hints for manual completion direct-send", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct-thread",
      },
      "agent:main:main": {
        sessionId: "requester-session-thread",
        lastChannel: "discord",
        lastTo: "channel:stale",
        lastThreadId: 42,
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-stale-thread",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "discord", to: "channel:12345", accountId: "acct-1" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.threadId).toBeUndefined();
  });

  it("passes requesterOrigin.threadId for manual completion direct-send", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-direct-thread-pass",
      },
      "agent:main:main": {
        sessionId: "requester-session-thread-pass",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-thread-pass",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "discord",
        to: "channel:12345",
        accountId: "acct-1",
        threadId: 99,
      },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).not.toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("discord");
    expect(call?.params?.to).toBe("channel:12345");
    expect(call?.params?.threadId).toBe("99");
  });

  it("steers announcements into an active run when queue mode is steer", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(true);
    embeddedRunMock.queueEmbeddedPiMessage.mockReturnValue(true);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "steer",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-789",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-123",
      expect.stringContaining("[System Message]"),
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("queues announce delivery with origin account routing", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-456",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-999",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("whatsapp");
    expect(params.to).toBe("+1555");
    expect(params.accountId).toBe("kev");
  });

  it("keeps queued idempotency unique for same-ms distinct child runs", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-followup",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "followup",
        queueDebounceMs: 0,
      },
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-1",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        task: "first task",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      });
      await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:worker",
        childRunId: "run-2",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        task: "second task",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      });
    } finally {
      nowSpy.mockRestore();
    }

    await expect.poll(() => agentSpy.mock.calls.length).toBe(2);
    const idempotencyKeys = agentSpy.mock.calls
      .map((call) => (call[0] as { params?: Record<string, unknown> })?.params?.idempotencyKey)
      .filter((value): value is string => typeof value === "string");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-1");
    expect(idempotencyKeys).toContain("announce:v1:agent:main:subagent:worker:run-2");
    expect(new Set(idempotencyKeys).size).toBe(2);
  });

  it("prefers direct delivery first for completion-mode and then queues on direct failure", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-collect",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };
    sendSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fallback",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => sendSpy.mock.calls.length).toBe(1);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "send",
      params: { sessionKey: "agent:main:main" },
    });
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: "agent:main:main" },
    });
    expect(agentSpy.mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: { channel: "whatsapp", to: "+1555", deliver: true },
    });
  });

  it("returns failure for completion-mode when direct delivery fails and queue fallback is unavailable", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-direct-only",
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
    };
    sendSpy.mockRejectedValueOnce(new Error("direct delivery unavailable"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-direct-fail",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledTimes(0);
  });

  it("uses assistant output for completion-mode when latest assistant text exists", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "old tool output" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant completion text" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("assistant ignored fallback");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-assistant-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => sendSpy.mock.calls.length).toBe(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("assistant completion text");
    expect(msg).not.toContain("old tool output");
  });

  it("falls back to latest tool output for completion-mode when assistant output is empty", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    chatHistoryMock.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "tool output only" }],
        },
      ],
    });
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-completion-tool-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      expectsCompletionMessage: true,
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => sendSpy.mock.calls.length).toBe(1);
    const call = sendSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("tool output only");
  });

  it("queues announce delivery back into requester subagent session", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:subagent:orchestrator": {
        sessionId: "session-orchestrator",
        spawnDepth: 1,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker-queued",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct" },
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it.each([
    {
      testName: "includes threadId when origin has an active topic/thread",
      childRunId: "run-thread",
      expectedThreadId: "42",
      requesterOrigin: undefined,
    },
    {
      testName: "prefers requesterOrigin.threadId over session entry threadId",
      childRunId: "run-thread-override",
      expectedThreadId: "99",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
        threadId: 99,
      },
    },
  ] as const)("$testName", async (testCase) => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-thread",
        lastChannel: "telegram",
        lastTo: "telegram:123",
        lastThreadId: 42,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      ...(testCase.requesterOrigin ? { requesterOrigin: testCase.requesterOrigin } : {}),
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("telegram");
    expect(params.to).toBe("telegram:123");
    expect(params.threadId).toBe(testCase.expectedThreadId);
  });

  it("splits collect-mode queues when accountId differs", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-acc-split",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-a",
        childRunId: "run-a",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-a" },
        ...defaultOutcomeAnnounce,
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        ...defaultOutcomeAnnounce,
      }),
    ]);

    await expect.poll(() => agentSpy.mock.calls.length).toBe(2);
    expect(agentSpy).toHaveBeenCalledTimes(2);
    const accountIds = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { accountId?: string } })?.params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it.each([
    {
      testName: "uses requester origin for direct announce when not queued",
      childRunId: "run-direct",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123" },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-123",
    },
    {
      testName: "normalizes requesterOrigin for direct announce delivery",
      childRunId: "run-direct-origin",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 " },
      expectedChannel: "whatsapp",
      expectedAccountId: "acct-987",
    },
  ] as const)("$testName", async (testCase) => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: testCase.childRunId,
      requesterSessionKey: "agent:main:main",
      requesterOrigin: testCase.requesterOrigin,
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      expectFinal?: boolean;
    };
    expect(call?.params?.channel).toBe(testCase.expectedChannel);
    expect(call?.params?.accountId).toBe(testCase.expectedAccountId);
    expect(call?.expectFinal).toBe(true);
  });

  it("injects direct announce into requester subagent session instead of chat channel", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(call?.params?.deliver).toBe(false);
    expect(call?.params?.channel).toBeUndefined();
    expect(call?.params?.to).toBeUndefined();
  });

  it("retries reading subagent output when early lifecycle completion had no text", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValueOnce(true).mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(true);
    readLatestAssistantReplyMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Read #12 complete.");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-1",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    };

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "context-stress-test",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(embeddedRunMock.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("child-session-1", 1000);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    expect(call?.params?.message).toContain("Read #12 complete.");
    expect(call?.params?.message).not.toContain("(no output)");
  });

  it("uses advisory guidance when sibling subagents are still active", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:main" ? 2 : 0,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("There are still 2 active subagent runs for this session.");
    expect(msg).toContain(
      "If they are part of the same workflow, wait for the remaining results before sending a user update.",
    );
    expect(msg).toContain("If they are unrelated, respond normally using only the result above.");
  });

  it("defers announce while the finished run still has active descendants", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    subagentRegistryMock.countActiveDescendantRuns.mockImplementation((sessionKey: string) =>
      sessionKey === "agent:main:subagent:parent" ? 1 : 0,
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:parent",
      childRunId: "run-parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(false);
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("bubbles child announce to parent requester when requester subagent already ended", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", to: "+1555", accountId: "acct-main" },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.to).toBe("+1555");
    expect(call?.params?.accountId).toBe("acct-main");
  });

  it("keeps announce retryable when ended requester subagent has no fallback requester", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue(null);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf-missing-fallback",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "agent:main:subagent:orchestrator",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(false);
    expect(subagentRegistryMock.resolveRequesterForChildSession).toHaveBeenCalledWith(
      "agent:main:subagent:orchestrator",
    );
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("defers announce when child run is still active after wait timeout", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-active",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-child-active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "context-stress-test",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(false);
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("prefers requesterOrigin channel over stale session lastChannel in queued announce", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    // Session store has stale whatsapp channel, but the requesterOrigin says bluebubbles.
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-stale",
        lastChannel: "whatsapp",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-stale-channel",
      requesterSessionKey: "main",
      requesterOrigin: { channel: "bluebubbles", to: "bluebubbles:chat_guid:123" },
      requesterDisplayKey: "main",
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    // The channel should match requesterOrigin, NOT the stale session entry.
    expect(call?.params?.channel).toBe("bluebubbles");
    expect(call?.params?.to).toBe("bluebubbles:chat_guid:123");
  });

  it("routes to parent subagent when parent run ended but session still exists (#18037)", async () => {
    // Scenario: Newton (depth-1) spawns Birdie (depth-2). Newton's agent turn ends
    // after spawning but Newton's SESSION still exists (waiting for Birdie's result).
    // Birdie completes → Birdie's announce should go to Newton, NOT to Jaris (depth-0).
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    // Parent's run has ended (no active run)
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    // BUT parent session still exists in the store
    sessionStore = {
      "agent:main:subagent:newton": {
        sessionId: "newton-session-id-alive",
        inputTokens: 100,
        outputTokens: 50,
      },
      "agent:main:subagent:newton:subagent:birdie": {
        sessionId: "birdie-session-id",
        inputTokens: 20,
        outputTokens: 10,
      },
    };
    // Fallback would be available to Jaris (grandparent)
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord" },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:newton:subagent:birdie",
      childRunId: "run-birdie",
      requesterSessionKey: "agent:main:subagent:newton",
      requesterDisplayKey: "subagent:newton",
      task: "QA the outline",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    // Verify announce went to Newton (the parent), NOT to Jaris (grandparent fallback)
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:subagent:newton");
    // deliver=false because Newton is a subagent (internal injection)
    expect(call?.params?.deliver).toBe(false);
    // Should NOT have used the grandparent fallback
    expect(call?.params?.sessionKey).not.toBe("agent:main:main");
  });

  it("falls back to grandparent only when parent session is deleted (#18037)", async () => {
    // Scenario: Parent session was cleaned up. Only then should we fallback.
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    // Parent's run ended AND session is gone
    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    // Parent session does NOT exist (was deleted)
    sessionStore = {
      "agent:main:subagent:birdie": {
        sessionId: "birdie-session-id",
        inputTokens: 20,
        outputTokens: 10,
      },
      // Newton's entry is MISSING (session was deleted)
    };
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord", accountId: "jaris-account" },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:birdie",
      childRunId: "run-birdie-orphan",
      requesterSessionKey: "agent:main:subagent:newton",
      requesterDisplayKey: "subagent:newton",
      task: "QA task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    // Verify announce fell back to Jaris (grandparent) since Newton is gone
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    // deliver=true because Jaris is main (user-facing)
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("discord");
  });

  it("falls back when parent session is missing a sessionId (#18037)", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    subagentRegistryMock.isSubagentSessionRunActive.mockReturnValue(false);
    sessionStore = {
      "agent:main:subagent:newton": {
        sessionId: " ",
        inputTokens: 100,
        outputTokens: 50,
      },
      "agent:main:subagent:newton:subagent:birdie": {
        sessionId: "birdie-session-id",
        inputTokens: 20,
        outputTokens: 10,
      },
    };
    subagentRegistryMock.resolveRequesterForChildSession.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord" },
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:newton:subagent:birdie",
      childRunId: "run-birdie-empty-parent",
      requesterSessionKey: "agent:main:subagent:newton",
      requesterDisplayKey: "subagent:newton",
      task: "QA task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.sessionKey).toBe("agent:main:main");
    expect(call?.params?.deliver).toBe(true);
    expect(call?.params?.channel).toBe("discord");
  });
});
