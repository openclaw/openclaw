import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions.js";
import * as gateway from "../gateway/call.js";
import * as sessionUtils from "../gateway/session-utils.fs.js";
import {
  isMainSessionResumable,
  recoverOrphanedMainSessions,
} from "./main-session-orphan-recovery.js";
import * as sessionDirs from "./session-dirs.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/openclaw-test-state"),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveStorePath: vi.fn(
    (_store: unknown, opts?: { agentId?: string }) =>
      `/tmp/openclaw-test-state/agents/${opts?.agentId ?? "main"}/agent/sessions.json`,
  ),
  updateSessionStore: vi.fn(
    async (_storePath: string, mutator: (store: Record<string, unknown>) => void) => {
      // Invoke the mutator with an empty store so the code path stays exercised.
      await mutator({});
    },
  ),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-main-run" })),
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  readSessionMessages: vi.fn(() => []),
}));

vi.mock("./session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => ["/tmp/openclaw-test-state/agents/main/sessions"]),
}));

type TestMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string; tool_use_id?: string }>;
  __openclaw?: Record<string, unknown>;
};

function toolResultTurn(toolUseId = "toolu_1"): TestMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId }],
  };
}

function userText(text: string): TestMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): TestMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function compactionMarker(): TestMessage {
  return {
    role: "system",
    content: [{ type: "text", text: "Compaction" }],
    __openclaw: { kind: "compaction" },
  };
}

function mockSingleRunningSession(
  entryOverrides: Partial<sessions.SessionEntry> = {},
  messages: unknown[] = [],
): void {
  vi.mocked(sessions.loadSessionStore).mockReturnValue({
    "agent:main:main": {
      sessionId: "session-main-1",
      updatedAt: Date.now(),
      status: "running",
      ...entryOverrides,
    } as sessions.SessionEntry,
  });
  vi.mocked(sessionUtils.readSessionMessages).mockReturnValue(messages);
}

function getResumeCall() {
  const call = vi.mocked(gateway.callGateway).mock.calls[0];
  expect(call).toBeDefined();
  return call[0];
}

describe("isMainSessionResumable", () => {
  it("returns true when tool_result tail has no assistant follow-up", () => {
    expect(
      isMainSessionResumable([
        userText("do the thing"),
        assistantText("running tool..."),
        toolResultTurn(),
      ]),
    ).toBe(true);
  });

  it("returns true with batched parallel tool_results and no follow-up", () => {
    expect(
      isMainSessionResumable([
        userText("search two things"),
        assistantText("firing two searches"),
        toolResultTurn("toolu_1"),
        toolResultTurn("toolu_2"),
      ]),
    ).toBe(true);
  });

  it("returns false when assistant message follows the tool_results", () => {
    expect(
      isMainSessionResumable([
        userText("do the thing"),
        assistantText("running tool..."),
        toolResultTurn(),
        assistantText("here is the answer"),
      ]),
    ).toBe(false);
  });

  it("returns false when transcript is empty", () => {
    expect(isMainSessionResumable([])).toBe(false);
  });

  it("returns false when transcript ends in a plain user message", () => {
    expect(isMainSessionResumable([assistantText("earlier answer"), userText("new request")])).toBe(
      false,
    );
  });

  it("ignores compaction markers when walking the tail", () => {
    expect(
      isMainSessionResumable([
        userText("do the thing"),
        assistantText("running tool..."),
        toolResultTurn(),
        compactionMarker(),
      ]),
    ).toBe(true);
  });
});

describe("recoverOrphanedMainSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionDirs.resolveAgentSessionDirs).mockResolvedValue([
      "/tmp/openclaw-test-state/agents/main/sessions",
    ]);
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "test-main-run" });
    vi.mocked(sessions.loadSessionStore).mockReturnValue({});
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([]);
    vi.mocked(sessions.resolveStorePath).mockImplementation(
      (_store, opts?: { agentId?: string }) =>
        `/tmp/openclaw-test-state/agents/${opts?.agentId ?? "main"}/agent/sessions.json`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resumes a main session stuck on tool_result tail", async () => {
    mockSingleRunningSession({}, [
      userText("please search"),
      assistantText("searching"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({
      nowMs: Date.now(),
      resumedSessionKeys: new Set<string>(),
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.skipped).toBe(0);

    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const call = getResumeCall();
    expect(call.method).toBe("agent");
    const callParams = call.params as Record<string, unknown>;
    expect(callParams.sessionKey).toBe("agent:main:main");
    expect(callParams.lane).toBe("main");
    expect(callParams.deliver).toBe(false);
    expect(typeof callParams.idempotencyKey).toBe("string");
    expect(callParams.message).toContain("gateway restart");
    expect(callParams.message).toContain("please search");
  });

  it("skips sessions whose transcript already ends in an assistant message", async () => {
    mockSingleRunningSession({}, [
      userText("please search"),
      assistantText("searching"),
      toolResultTurn(),
      assistantText("here is the answer"),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.expired).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
  });

  it("skips entries whose status is not 'running'", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:main": {
        sessionId: "session-main-1",
        updatedAt: Date.now(),
        status: "done",
      } as sessions.SessionEntry,
    });

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("skips subagent entries by spawnDepth (handled by subagent orphan recovery)", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:abc": {
        sessionId: "session-sub-1",
        updatedAt: Date.now(),
        status: "running",
        spawnDepth: 1,
      } as sessions.SessionEntry,
    });
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      userText("sub task"),
      assistantText("running"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("skips subagent entries by subagentRole when spawnDepth is unset", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:other:xyz": {
        sessionId: "session-sub-2",
        updatedAt: Date.now(),
        status: "running",
        subagentRole: "leaf",
      } as sessions.SessionEntry,
    });
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      userText("leaf task"),
      assistantText("running"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("skips cron runs (lifecycle owned by cron scheduler)", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:cron:daily:run:abc": {
        sessionId: "session-cron-1",
        updatedAt: Date.now(),
        status: "running",
      } as sessions.SessionEntry,
    });
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      userText("cron prompt"),
      assistantText("running"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("skips ACP sessions (lifecycle owned by ACP control plane)", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:acp:some-acp-id": {
        sessionId: "session-acp-1",
        updatedAt: Date.now(),
        status: "running",
      } as sessions.SessionEntry,
    });
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      userText("acp request"),
      assistantText("running"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("marks stale running sessions as failed when tail is not resumable", async () => {
    const now = Date.now();
    mockSingleRunningSession({ updatedAt: now - 2 * 60 * 60 * 1000 }, [
      userText("hello"),
      assistantText("hi"),
    ]);

    const result = await recoverOrphanedMainSessions({
      nowMs: now,
      staleMs: 60 * 60 * 1000,
    });

    expect(result.expired).toBe(1);
    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();

    const [storePath, mutator] = vi.mocked(sessions.updateSessionStore).mock.calls[0];
    expect(storePath).toContain("/agents/main/agent/sessions.json");

    const simulated: Record<string, sessions.SessionEntry> = {
      "agent:main:main": {
        sessionId: "session-main-1",
        updatedAt: now - 2 * 60 * 60 * 1000,
        status: "running",
      } as sessions.SessionEntry,
    };
    await (mutator as (s: Record<string, sessions.SessionEntry>) => Promise<void> | void)(
      simulated,
    );
    expect(simulated["agent:main:main"]?.status).toBe("failed");
    expect(simulated["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(simulated["agent:main:main"]?.updatedAt).toBe(now);
  });

  it("does not resurrect stale resumable sessions beyond the stale window", async () => {
    const now = Date.now();
    mockSingleRunningSession({ updatedAt: now - 2 * 60 * 60 * 1000 }, [
      userText("long ago"),
      assistantText("searching"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({
      nowMs: now,
      staleMs: 60 * 60 * 1000,
    });

    expect(result.expired).toBe(1);
    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
  });

  it("preserves running status when callGateway fails so next restart can retry", async () => {
    mockSingleRunningSession({}, [
      userText("please search"),
      assistantText("searching"),
      toolResultTurn(),
    ]);
    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("gateway unavailable"));

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
  });

  it("truncates very long last human messages in the resume prompt", async () => {
    const longText = "x".repeat(5000);
    mockSingleRunningSession({}, [
      userText(longText),
      assistantText("searching"),
      toolResultTurn(),
    ]);

    await recoverOrphanedMainSessions({ nowMs: Date.now() });

    const call = getResumeCall();
    const message = (call.params as Record<string, unknown>).message as string;
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain("...");
  });

  it("dedupes resumed sessions across retries via resumedSessionKeys", async () => {
    mockSingleRunningSession({}, [
      userText("please search"),
      assistantText("searching"),
      toolResultTurn(),
    ]);

    const resumedSessionKeys = new Set<string>();
    const first = await recoverOrphanedMainSessions({
      nowMs: Date.now(),
      resumedSessionKeys,
    });
    const second = await recoverOrphanedMainSessions({
      nowMs: Date.now(),
      resumedSessionKeys,
    });

    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(second.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("scans every agent session directory and dedupes by store path", async () => {
    vi.mocked(sessionDirs.resolveAgentSessionDirs).mockResolvedValue([
      "/tmp/openclaw-test-state/agents/main/sessions",
      "/tmp/openclaw-test-state/agents/ops/sessions",
    ]);

    const runningEntry = (sessionId: string): sessions.SessionEntry =>
      ({
        sessionId,
        updatedAt: Date.now(),
        status: "running",
      }) as sessions.SessionEntry;

    vi.mocked(sessions.loadSessionStore).mockImplementation((storePath) => {
      const store: Record<string, sessions.SessionEntry> = {};
      if (storePath.includes("/agents/main/")) {
        store["agent:main:main"] = runningEntry("session-main-1");
      } else if (storePath.includes("/agents/ops/")) {
        store["agent:ops:main"] = runningEntry("session-ops-1");
      }
      return store;
    });
    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      userText("please search"),
      assistantText("searching"),
      toolResultTurn(),
    ]);

    const result = await recoverOrphanedMainSessions({ nowMs: Date.now() });

    expect(result.recovered).toBe(2);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
    const resumedKeys = vi
      .mocked(gateway.callGateway)
      .mock.calls.map((call) => (call[0].params as Record<string, unknown>).sessionKey);
    expect(resumedKeys).toContain("agent:main:main");
    expect(resumedKeys).toContain("agent:ops:main");
  });
});
