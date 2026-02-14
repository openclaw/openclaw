import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCalls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
const readLatestAssistantReplyMock = vi.fn(async () => "nested result");
const getAncestorsMock = vi.fn<(sessionKey: string) => string[]>(() => []);
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};

let sessionStore: Record<string, Record<string, unknown>> = {};
let failSessionKeys = new Set<string>();
let configOverride = {
  session: {
    mainKey: "main",
    scope: "per-sender" as const,
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { sessionKey?: string } };
    if (typed.method === "agent") {
      agentCalls.push(typed as { method?: string; params?: Record<string, unknown> });
      const sessionKey = typed.params?.sessionKey?.trim();
      if (sessionKey && failSessionKeys.has(sessionKey)) {
        throw new Error(`dead session: ${sessionKey}`);
      }
      return { status: "ok" };
    }
    if (typed.method === "agent.wait") {
      return { status: "ok", startedAt: 10, endedAt: 20 };
    }
    if (typed.method === "sessions.patch" || typed.method === "sessions.delete") {
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("./tools/sessions-lineage.js", () => ({
  getAncestors: getAncestorsMock,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("./pi-embedded.js", () => embeddedRunMock);

describe("subagent announce nested routing", () => {
  beforeEach(() => {
    agentCalls.length = 0;
    failSessionKeys = new Set<string>();
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("nested result");
    getAncestorsMock.mockReset().mockReturnValue([]);
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
  });

  it("routes nested announce to parent only with deliver=false", async () => {
    getAncestorsMock.mockReturnValue(["agent:main:main"]);
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:parent:sub:child",
      childRunId: "run-nested-parent-only",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "subagent:parent",
      task: "nested task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.params?.sessionKey).toBe("agent:main:subagent:parent");
    expect(agentCalls[0]?.params?.deliver).toBe(false);
    expect(agentCalls[0]?.params?.lane).toBe("subagent");
  });

  it("falls back to ancestors when parent session is unreachable", async () => {
    getAncestorsMock.mockReturnValue(["agent:main:subagent:grandparent", "agent:main:main"]);
    failSessionKeys.add("agent:main:subagent:parent");
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:parent:sub:child",
      childRunId: "run-nested-escalate",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "subagent:parent",
      task: "nested task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.params?.sessionKey).toBe("agent:main:subagent:parent");
    expect(agentCalls[1]?.params?.sessionKey).toBe("agent:main:subagent:grandparent");
    expect(agentCalls[0]?.params?.deliver).toBe(false);
    expect(agentCalls[1]?.params?.deliver).toBe(false);
  });

  it("keeps root-spawned subagent announce behavior unchanged", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:child",
      childRunId: "run-root-behavior",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "root task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.params?.sessionKey).toBe("agent:main:main");
    expect(agentCalls[0]?.params?.deliver).toBe(true);
    expect(agentCalls[0]?.params?.lane).toBeUndefined();
    expect(getAncestorsMock).not.toHaveBeenCalled();
  });

  it("warns and does not throw when all ancestor deliveries fail", async () => {
    getAncestorsMock.mockReturnValue(["agent:main:subagent:grandparent", "agent:main:main"]);
    failSessionKeys = new Set([
      "agent:main:subagent:parent",
      "agent:main:subagent:grandparent",
      "agent:main:main",
    ]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    await expect(
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:parent:sub:child",
        childRunId: "run-nested-unreachable",
        requesterSessionKey: "agent:main:subagent:parent",
        requesterDisplayKey: "subagent:parent",
        task: "nested task",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        outcome: { status: "ok" },
      }),
    ).resolves.toBe(true);

    expect(agentCalls).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[subagent-announce] Failed to deliver nested announce"),
    );
    warnSpy.mockRestore();
  });
});
