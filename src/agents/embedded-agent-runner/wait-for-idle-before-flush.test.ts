// Verifies flushPendingToolResultsAfterIdle defer behavior.
import { setImmediate } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

describe("flushPendingToolResultsAfterIdle", () => {
  it("defers flush by one event-loop tick when not aborted", async () => {
    const flush = vi.fn();
    const sessionManager = { flushPendingToolResults: flush };

    const promise = flushPendingToolResultsAfterIdle({ agent: null, sessionManager });
    // Not flushed synchronously
    expect(flush).not.toHaveBeenCalled();

    await promise;
    expect(flush).toHaveBeenCalledOnce();
  });

  it("flushes synchronously when timeoutMs=0 (abort path)", async () => {
    // Abort/timeout callers use timeoutMs=0 for synchronous flush
    // before releasing the session lock. This path skips the defer.
    const flush = vi.fn();
    const sessionManager = { flushPendingToolResults: flush };

    const promise = flushPendingToolResultsAfterIdle({
      agent: null,
      sessionManager,
      timeoutMs: 0,
    });
    // Flush runs synchronously — no defer in abort path
    expect(flush).toHaveBeenCalledOnce();

    await promise;
    expect(flush).toHaveBeenCalledOnce();
  });

  it("allows real tool result to clear pending before flush (#84134 regression)", async () => {
    // Simulates #84134: pending tool call exists at cleanup time,
    // real result arrives in the next event-loop tick (as Feishu
    // HTTP responses do). On main (no defer), flush fires
    // synchronously after idle → synthetic injected before the
    // real result arrives. On this branch, the setImmediate defer
    // lets the real result clear the pending map first.
    const pending = new Set(["tc_msg"]);
    let syntheticInjected = false;

    const sessionManager = {
      flushPendingToolResults: vi.fn(() => {
        if (pending.size > 0) {
          syntheticInjected = true;
        }
      }),
    } as const;

    // Schedule the "real result" to arrive asynchronously — this
    // represents the Feishu HTTP response arriving in a subsequent
    // event-loop phase (I/O poll or check).  On main the flush
    // fires before this callback; on the PR branch the setImmediate
    // defer drains the event loop first.
    setImmediate(() => {
      pending.delete("tc_msg");
    });

    await flushPendingToolResultsAfterIdle({ agent: null, sessionManager });

    expect(sessionManager.flushPendingToolResults).toHaveBeenCalledOnce();
    expect(syntheticInjected).toBe(false);
  });
});
