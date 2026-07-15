// Subagent registry helper tests cover orphan reconciliation and compact logging
// for announce delivery give-up paths.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  capFrozenResultText,
  deleteSubagentSessionWithRetry,
  logAnnounceGiveUp,
  reconcileOrphanedRun,
} from "./subagent-registry-helpers.js";
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

describe("capFrozenResultText", () => {
  it("preserves a valid UTF-8 prefix within the frozen-result byte budget", () => {
    const result = capFrozenResultText("😀".repeat(25_601));

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(result).not.toContain("�");
    expect(result).toContain("[truncated: frozen completion output exceeded 100KB");
  });
});

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

describe("logAnnounceGiveUp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the last delivery error in retry-limit warnings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      delivery: {
        status: "failed",
        attemptCount: 3,
        lastError: "direct-primary: routed-dispatch-did-not-queue-final",
      },
    });

    logAnnounceGiveUp(entry, "retry-limit");

    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Subagent announce give up (retry-limit) run=run-1 child=agent:main:subagent:child requester=agent:main:main retries=3 endedAgo=5s deliveryError="direct-primary: routed-dispatch-did-not-queue-final"',
    );
    logSpy.mockRestore();
  });

  it("normalizes multiline delivery errors onto one gateway log line", () => {
    // Gateway logs are line-oriented; multiline provider errors must be
    // collapsed before they enter warning text.
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: "gateway timeout\nphase: routed dispatch failed",
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('deliveryError="gateway timeout phase: routed dispatch failed"'),
    );
    logSpy.mockRestore();
  });

  it("keeps bounded delivery errors UTF-16 well-formed", () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: `${"x".repeat(1_999)}🚀tail`,
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain(`${"x".repeat(1_999)}…`);
    expect(line).not.toContain("\uD83D");
    logSpy.mockRestore();
  });
});

describe("deleteSubagentSessionWithRetry", () => {
  function makeTransientError(message = "gateway closed (1006): transport close") {
    const err = new Error(message);
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

  it("retries lifecycle readiness failures shared with subagent spawn", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(makeTransientError("WebSocket handshake timeout after 10000ms"))
      .mockRejectedValueOnce(
        makeTransientError("Gateway not yet ready to accept connections (retry after a moment)"),
      )
      .mockResolvedValueOnce({});

    await deleteSubagentSessionWithRetry({
      callGateway,
      sessionKey: "agent:main:subagent:abc",
    });

    expect(callGateway).toHaveBeenCalledTimes(3);
  });
});
