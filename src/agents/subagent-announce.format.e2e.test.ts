import { beforeEach, describe, expect, it, vi } from "vitest";

const agentSpy = vi.fn(async () => ({ runId: "run-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn();
const readLatestAssistantReplyMock = vi.fn(async () => "raw subagent reply");
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
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
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

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
    sessionsDeleteSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
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
    expect(msg).toContain("subagent task");
    expect(msg).toContain("failed");
    expect(msg).toContain("boom");
    expect(msg).toContain("Findings:");
    expect(msg).toContain("raw subagent reply");
    expect(msg).toContain("Stats:");
  });

  it("includes success status when outcome is ok", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    // Use waitForCompletion: false so it uses the provided outcome instead of calling agent.wait
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    const call = agentSpy.mock.calls[0]?.[0] as { params?: { message?: string } };
    const msg = call?.params?.message as string;
    expect(msg).toContain("completed successfully");
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
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-123",
      expect.stringContaining("subagent task"),
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
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.to).toBe("+1555");
    expect(call?.params?.accountId).toBe("kev");
  });

  it("includes threadId when origin has an active topic/thread", async () => {
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
      childRunId: "run-thread",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("telegram");
    expect(call?.params?.to).toBe("telegram:123");
    expect(call?.params?.threadId).toBe("42");
  });

  it("prefers requesterOrigin.threadId over session entry threadId", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-thread-override",
        lastChannel: "telegram",
        lastTo: "telegram:123",
        lastThreadId: 42,
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-thread-override",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
        threadId: 99,
      },
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.threadId).toBe("99");
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
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
    ]);

    await expect.poll(() => agentSpy.mock.calls.length).toBe(2);
    expect(agentSpy).toHaveBeenCalledTimes(2);
    const accountIds = agentSpy.mock.calls.map(
      (call) => (call?.[0] as { params?: { accountId?: string } })?.params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it("uses requester origin for direct announce when not queued", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123" },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.accountId).toBe("acct-123");
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

  it("does not delete child session when announce is deferred for an active run", async () => {
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
      childRunId: "run-child-active-delete",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "context-stress-test",
      timeoutMs: 1000,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(false);
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("normalizes requesterOrigin for direct announce delivery", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-origin",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 " },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("whatsapp");
    expect(call?.params?.accountId).toBe("acct-987");
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
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);

    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    // The channel should match requesterOrigin, NOT the stale session entry.
    expect(call?.params?.channel).toBe("bluebubbles");
    expect(call?.params?.to).toBe("bluebubbles:chat_guid:123");
  });
});
