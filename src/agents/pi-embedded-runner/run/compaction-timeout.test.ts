import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
  waitForCompactionRetryWithTimeout,
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
    const pre = [{ role: "assistant", content: "pre" } as unknown as AgentMessage] as const;
    const current = [{ role: "assistant", content: "current" } as unknown as AgentMessage] as const;
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
    const current = [{ role: "assistant", content: "current" } as unknown as AgentMessage] as const;
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

  it("returns false when compaction wait exceeds timeout", async () => {
    vi.useFakeTimers();
    const waitPromise = waitForCompactionRetryWithTimeout({
      waitForCompactionRetry: async () => {
        await new Promise(() => {});
      },
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(55);
    await expect(waitPromise).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("returns true when compaction wait settles before timeout", async () => {
    vi.useFakeTimers();
    const waitPromise = waitForCompactionRetryWithTimeout({
      waitForCompactionRetry: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(15);
    await expect(waitPromise).resolves.toBe(true);
    vi.useRealTimers();
  });

  it("propagates compaction wait rejection", async () => {
    const expected = new Error("compaction failed");
    await expect(
      waitForCompactionRetryWithTimeout({
        waitForCompactionRetry: async () => {
          throw expected;
        },
        timeoutMs: 50,
      }),
    ).rejects.toBe(expected);
  });
});
