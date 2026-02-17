import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueAnnounceSpy = vi.fn();
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const readLatestAssistantReplyMock = vi.fn(async () => "subagent reply");
const agentSpy = vi.fn(async () => ({ runId: "run-main", status: "ok" }));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;

vi.mock("./subagent-announce-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce-queue.js")>();
  return {
    ...actual,
    enqueueAnnounce: enqueueAnnounceSpy,
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "ok", startedAt: 10, endedAt: 20 };
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
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

describe("collect-mode gate fix", () => {
  beforeEach(() => {
    enqueueAnnounceSpy.mockClear();
    agentSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("subagent reply");

    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "discord",
        // No explicit queueMode → defaults to "collect"
      },
    };
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("queues announce in collect mode even when parent is NOT active", async () => {
    // Parent agent is idle (not running)
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-123",
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

    // With collect mode + idle parent, enqueueAnnounce SHOULD be called
    expect(enqueueAnnounceSpy).toHaveBeenCalled();
    // And the direct callGateway agent call should NOT happen (queued instead)
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("still steers when queue mode is steer and parent is active", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.queueEmbeddedPiMessage.mockReturnValue(true);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "discord",
        queueMode: "steer",
      },
    };

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
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

    // Steer mode should not use enqueueAnnounce when steering succeeds
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalled();
    expect(enqueueAnnounceSpy).not.toHaveBeenCalled();
  });

  it("followup mode still requires isActive (no regression)", async () => {
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "discord",
        queueMode: "followup",
      },
    };

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
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

    // followup mode + idle parent → should NOT queue, falls through to direct announce
    expect(enqueueAnnounceSpy).not.toHaveBeenCalled();
    expect(agentSpy).toHaveBeenCalled();
  });
});
