import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({})),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => () => {}),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("../config/sessions.js", () => {
  const sessionStore = new Proxy<Record<string, { sessionId: string; updatedAt: number }>>(
    {},
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return { sessionId: `sess-${prop}`, updatedAt: 1 };
      },
    },
  );

  return {
    loadSessionStore: vi.fn(() => sessionStore),
    resolveAgentIdFromSessionKey: (key: string) => {
      const match = key.match(/^agent:([^:]+)/);
      return match?.[1] ?? "main";
    },
    resolveMainSessionKey: () => "agent:main:main",
    resolveStorePath: () => "/tmp/test-store",
    updateSessionStore: vi.fn(),
  };
});

const announceSpy = vi.fn(async () => true);
const emitSessionLifecycleEventMock = vi.fn();

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: () => false,
    runSubagentEnded: vi.fn(async () => {}),
  })),
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: emitSessionLifecycleEventMock,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("completeSubagentRun idempotency", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  afterEach(() => {
    emitSessionLifecycleEventMock.mockClear();
    announceSpy.mockClear();
  });

  const registerRun = (runId: string) => {
    mod.registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test task",
      cleanup: "keep",
    });
  };

  it("first completion runs full finalization even when endedAt is pre-set", async () => {
    registerRun("run-idem-0");

    // Simulate what waitForSubagentCompletion does: set endedAt on the entry
    // BEFORE calling completeSubagentRun.
    const runs0 = mod.listSubagentRunsForRequester("agent:main:main");
    const preEntry = runs0.find((r) => r.runId === "run-idem-0");
    expect(preEntry).toBeDefined();
    preEntry!.endedAt = 500;

    await mod.completeSubagentRun({
      runId: "run-idem-0",
      endedAt: 500,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const afterEntry = runs0.find((r) => r.runId === "run-idem-0");
    // completionFinalized proves the full finalization path ran.
    expect(afterEntry?.completionFinalized).toBe(true);
    expect(afterEntry?.endedAt).toBe(500);
    expect(afterEntry?.outcome).toEqual({ status: "ok" });
    expect(afterEntry?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
  });

  it("second call is a no-op for a finalized run", async () => {
    registerRun("run-idem-1");

    // First completion should succeed.
    await mod.completeSubagentRun({
      runId: "run-idem-1",
      endedAt: 1000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const runs1 = mod.listSubagentRunsForRequester("agent:main:main");
    const entry1 = runs1.find((r) => r.runId === "run-idem-1");
    expect(entry1?.endedAt).toBe(1000);
    expect(entry1?.completionFinalized).toBe(true);

    emitSessionLifecycleEventMock.mockClear();

    // Second completion with a different endedAt should be ignored.
    await mod.completeSubagentRun({
      runId: "run-idem-1",
      endedAt: 2000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const runs2 = mod.listSubagentRunsForRequester("agent:main:main");
    const entry2 = runs2.find((r) => r.runId === "run-idem-1");
    // endedAt should NOT have been mutated by the second call.
    expect(entry2?.endedAt).toBe(1000);
    // No lifecycle event emitted on duplicate.
    expect(emitSessionLifecycleEventMock).not.toHaveBeenCalled();
  });

  it("allows recovery path when reason=complete after kill with cleanup handled", async () => {
    registerRun("run-idem-2");

    // Simulate an earlier kill completion.
    await mod.completeSubagentRun({
      runId: "run-idem-2",
      endedAt: 1000,
      outcome: { status: "error", error: "killed" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: false,
    });

    // Mark cleanup as handled (simulating what the kill path does).
    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "run-idem-2");
    expect(entry).toBeDefined();
    // Directly set the fields the recovery path checks.
    entry!.suppressAnnounceReason = "killed";
    entry!.cleanupHandled = true;

    emitSessionLifecycleEventMock.mockClear();

    // A late lifecycle completion should be allowed through the recovery path.
    await mod.completeSubagentRun({
      runId: "run-idem-2",
      endedAt: 3000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: false,
    });

    const runsAfter = mod.listSubagentRunsForRequester("agent:main:main");
    const entryAfter = runsAfter.find((r) => r.runId === "run-idem-2");
    // Recovery path should update endedAt and clear suppressAnnounceReason.
    expect(entryAfter?.endedAt).toBe(3000);
    expect(entryAfter?.suppressAnnounceReason).toBeUndefined();
  });
});
