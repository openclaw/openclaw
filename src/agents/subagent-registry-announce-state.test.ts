import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const hoisted = vi.hoisted(() => ({
  getLatestRunByChildSessionKey: vi.fn(),
  persistSubagentRunsToDisk: vi.fn(),
  resumeSubagentRun: vi.fn(),
}));

vi.mock("./subagent-registry-read.js", () => ({
  getLatestSubagentRunByChildSessionKey: hoisted.getLatestRunByChildSessionKey,
}));

vi.mock("./subagent-registry-state.js", () => ({
  persistSubagentRunsToDisk: hoisted.persistSubagentRunsToDisk,
}));

import {
  __testing,
  clearStaleSubagentAnnouncePendingState,
  markSubagentAnnounceDelivered,
  markSubagentAnnouncePending,
} from "./subagent-registry-announce-state.js";

describe("subagent registry announce state", () => {
  beforeEach(() => {
    subagentRuns.clear();
    hoisted.getLatestRunByChildSessionKey.mockReset();
    hoisted.getLatestRunByChildSessionKey.mockReturnValue(null);
    hoisted.persistSubagentRunsToDisk.mockClear();
    hoisted.resumeSubagentRun.mockClear();
    __testing.setDepsForTest({
      resumeSubagentRun: hoisted.resumeSubagentRun,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    subagentRuns.clear();
    __testing.setDepsForTest();
  });

  it("tracks pending and delivered state by sourceRunId and resumes the matching run", async () => {
    const run: SubagentRunRecord = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do the thing",
      cleanup: "keep",
      createdAt: Date.now(),
    };
    subagentRuns.set(run.runId, run);

    markSubagentAnnouncePending({
      announceId: "announce-1",
      sourceRunId: run.runId,
    });

    expect(run.pendingAnnounceId).toBe("announce-1");
    expect(run.pendingAnnounceAt).toBeTypeOf("number");
    expect(hoisted.persistSubagentRunsToDisk).toHaveBeenCalledTimes(1);

    markSubagentAnnounceDelivered({
      announceId: "announce-1",
      sourceRunId: run.runId,
    });

    expect(run.lastAnnounceDeliveredId).toBe("announce-1");
    expect(run.lastAnnounceDeliveredAt).toBeTypeOf("number");
    expect(run.pendingAnnounceId).toBeUndefined();
    expect(run.pendingAnnounceAt).toBeUndefined();
    expect(hoisted.persistSubagentRunsToDisk).toHaveBeenCalledTimes(2);

    await vi.runAllTimersAsync();
    expect(hoisted.resumeSubagentRun).toHaveBeenCalledWith(run.runId);
  });

  it("clears stale pending announces without touching delivered markers", () => {
    const run: SubagentRunRecord = {
      runId: "run-2",
      childSessionKey: "agent:main:subagent:test-2",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "keep it clean",
      cleanup: "keep",
      createdAt: Date.now(),
      pendingAnnounceId: "announce-stale",
      pendingAnnounceAt: 123,
      lastAnnounceDeliveredId: "announce-old",
      lastAnnounceDeliveredAt: 456,
    };
    subagentRuns.set(run.runId, run);

    expect(clearStaleSubagentAnnouncePendingState()).toBe(true);
    expect(run.pendingAnnounceId).toBeUndefined();
    expect(run.pendingAnnounceAt).toBeUndefined();
    expect(run.lastAnnounceDeliveredId).toBe("announce-old");
    expect(run.lastAnnounceDeliveredAt).toBe(456);
    expect(hoisted.persistSubagentRunsToDisk).toHaveBeenCalledTimes(1);
  });
});
