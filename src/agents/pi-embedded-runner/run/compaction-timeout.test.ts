import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";

describe("compaction-timeout helpers", () => {
  it("flags compaction timeout consistently for internal and external timeout sources", () => {
    const internalTimer = shouldFlagCompactionTimeout({
      isTimeout: true,
      isCompactionPendingOrRetrying: true,
      isCompactionInFlight: false,
    });
    const externalAbort = shouldFlagCompactionTimeout({
      isTimeout: true,
      isCompactionPendingOrRetrying: true,
      isCompactionInFlight: false,
    });
    expect(internalTimer).toBe(true);
    expect(externalAbort).toBe(true);
  });

  it("does not flag when timeout is false", () => {
    expect(
      shouldFlagCompactionTimeout({
        isTimeout: false,
        isCompactionPendingOrRetrying: true,
        isCompactionInFlight: true,
      }),
    ).toBe(false);
  });

  it("extends the first run timeout reached during compaction", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: false,
        isCompactionInFlight: true,
        graceAlreadyUsed: false,
      }),
    ).toBe("extend");
  });

  it("aborts after compaction grace has already been used", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: true,
        isCompactionInFlight: false,
        graceAlreadyUsed: true,
      }),
    ).toBe("abort");
  });

  it("aborts immediately when no compaction is active", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        isCompactionPendingOrRetrying: false,
        isCompactionInFlight: false,
        graceAlreadyUsed: false,
      }),
    ).toBe("abort");
  });

  it("adds one compaction grace window to the run timeout budget", () => {
    expect(
      resolveRunTimeoutWithCompactionGraceMs({
        runTimeoutMs: 600_000,
        compactionTimeoutMs: 900_000,
      }),
    ).toBe(1_500_000);
  });

  it("uses pre-compaction snapshot when compaction timeout occurs", () => {
    const pre = [castAgentMessage({ role: "assistant", content: "pre" })] as const;
    const current = [castAgentMessage({ role: "assistant", content: "current" })] as const;
    const selected = selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: [...pre],
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
    });
    expect(selected.source).toBe("pre-compaction");
    expect(selected.sessionIdUsed).toBe("session-pre");
    expect(selected.messagesSnapshot).toEqual(pre);
  });

  it("falls back to current snapshot when pre-compaction snapshot is unavailable", () => {
    const current = [castAgentMessage({ role: "assistant", content: "current" })] as const;
    const selected = selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction: true,
      preCompactionSnapshot: null,
      preCompactionSessionId: "session-pre",
      currentSnapshot: [...current],
      currentSessionId: "session-current",
    });
    expect(selected.source).toBe("current");
    expect(selected.sessionIdUsed).toBe("session-current");
    expect(selected.messagesSnapshot).toEqual(current);
  });
});
