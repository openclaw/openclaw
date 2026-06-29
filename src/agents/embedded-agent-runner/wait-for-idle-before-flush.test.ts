// Verifies flushPendingToolResultsAfterIdle defers via setImmediate.
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

  it("skips idle wait but still defers when timeoutMs=0", async () => {
    const flush = vi.fn();
    const sessionManager = { flushPendingToolResults: flush };

    const promise = flushPendingToolResultsAfterIdle({
      agent: null,
      sessionManager,
      timeoutMs: 0,
    });
    expect(flush).not.toHaveBeenCalled();

    await promise;
    expect(flush).toHaveBeenCalledOnce();
  });

  it("allows real tool result to clear pending before flush", async () => {
    // Simulates #84134: pending tool call exists at cleanup time,
    // real result arrives during the setImmediate gap, no synthetic.
    const pending = new Set(["tc_msg"]);
    let syntheticInjected = false;

    const sessionManager = {
      flushPendingToolResults: vi.fn(() => {
        if (pending.size > 0) syntheticInjected = true;
      }),
    } as const;

    const promise = flushPendingToolResultsAfterIdle({ agent: null, sessionManager });

    // Real result arrives during the setImmediate gap
    pending.delete("tc_msg");

    await promise;
    expect(sessionManager.flushPendingToolResults).toHaveBeenCalledOnce();
    expect(syntheticInjected).toBe(false);
  });
});
