import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSubagentSessionWithRetry, reconcileOrphanedRun } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves timing on orphaned error outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-id",
        source: "resume",
        runs,
        resumedRuns,
      }),
    ).toBe(true);

    expect(entry.endedAt).toBe(4_000);
    expect(entry.outcome).toEqual({
      status: "error",
      error: "orphaned subagent run (missing-session-id)",
      startedAt: 1_000,
      endedAt: 4_000,
      elapsedMs: 3_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
    expect(resumedRuns.has(entry.runId)).toBe(false);
  });
});

describe("deleteSubagentSessionWithRetry", () => {
  function makeTransientError() {
    const err = new Error("gateway closed (1006): transport close");
    return err;
  }

  function makePermanentError() {
    return new Error("session not found");
  }

  it("succeeds on first attempt when the gateway call works", async () => {
    const callGateway = vi.fn().mockResolvedValue({});
    await deleteSubagentSessionWithRetry({ callGateway, sessionKey: "agent:main:subagent:abc" });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: { key: "agent:main:subagent:abc", deleteTranscript: true, emitLifecycleHooks: false },
      timeoutMs: 10_000,
    });
  });

  it("does not retry on non-transient errors", async () => {
    const callGateway = vi.fn().mockRejectedValue(makePermanentError());
    await expect(
      deleteSubagentSessionWithRetry({ callGateway, sessionKey: "agent:main:subagent:abc" }),
    ).rejects.toThrow("session not found");
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("retries up to the limit on transient errors", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce({});

    await deleteSubagentSessionWithRetry({
      callGateway,
      sessionKey: "agent:main:subagent:abc",
    });

    expect(callGateway).toHaveBeenCalledTimes(3);
  });

  it("throws the last transient error after exhausting retries", async () => {
    const callGateway = vi.fn().mockRejectedValue(makeTransientError());

    await expect(
      deleteSubagentSessionWithRetry({
        callGateway,
        sessionKey: "agent:main:subagent:abc",
      }),
    ).rejects.toThrow("transport close");
    expect(callGateway).toHaveBeenCalledTimes(3);
  });
});
