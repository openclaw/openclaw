import { describe, expect, it } from "vitest";
import {
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

  it("uses pre-compaction snapshot when compaction timeout occurs", () => {
    const pre = [{ role: "assistant", content: "pre" }] as const;
    const current = [{ role: "assistant", content: "current" }] as const;
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
    const current = [{ role: "assistant", content: "current" }] as const;
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
