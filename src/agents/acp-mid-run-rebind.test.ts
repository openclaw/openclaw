// Phase 5 Discord Surface Overhaul — mid-run rebinding regression.
//
// Scenario: a parent session is bound to thread-A. A child ACP session is
// spawned mid-turn. Before the child emits its final_reply, the parent
// session is rebound to thread-B (user moves the conversation, or a new
// binding takes over). Subsequent emissions that read the parent's delivery
// context MUST route to thread-B, and no emission may reuse the stale
// thread-A context after the rebind.
//
// The seam that makes this possible is `session-delivery-cache`: callers
// (F3 direct-post path in `acp-spawn-parent-stream.ts`; the agent delivery
// planner; announce delivery) must read the live cache each time they
// resolve the parent's destination — not snapshot the context once at spawn
// time. These tests lock that invariant by asserting cache reads, not by
// driving the full relay loop (which is owned by Phase 9's receipt work).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCachedDeliveryContext,
  getCachedDeliveryContext,
  resetDeliveryCacheForTest,
  setCachedDeliveryContext,
} from "../infra/outbound/session-delivery-cache.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const PARENT_KEY = "agent:main:main";
const THREAD_A: DeliveryContext = {
  channel: "discord",
  to: "channel:guild-1",
  threadId: "thread-A-1111111111",
};
const THREAD_B: DeliveryContext = {
  channel: "discord",
  to: "channel:guild-1",
  threadId: "thread-B-2222222222",
};

describe("mid-run rebind: parent session moves to a different thread", () => {
  beforeEach(() => {
    resetDeliveryCacheForTest();
  });

  afterEach(() => {
    resetDeliveryCacheForTest();
  });

  it("subsequent context reads reflect the NEW thread after rebind", () => {
    // Initial binding: parent turn starts bound to thread-A.
    setCachedDeliveryContext(PARENT_KEY, THREAD_A);
    const atSpawn = getCachedDeliveryContext(PARENT_KEY);
    expect(atSpawn?.threadId).toBe("thread-A-1111111111");

    // Rebind happens mid-run (user moves conversation, binding service
    // updates). Any consumer that re-reads the cache sees thread-B.
    setCachedDeliveryContext(PARENT_KEY, THREAD_B);
    const afterRebind = getCachedDeliveryContext(PARENT_KEY);
    expect(afterRebind?.threadId).toBe("thread-B-2222222222");
  });

  it("old thread-A context is no longer reachable through the cache after rebind", () => {
    setCachedDeliveryContext(PARENT_KEY, THREAD_A);
    setCachedDeliveryContext(PARENT_KEY, THREAD_B);

    // Emissions that resolve through the cache must only ever see thread-B;
    // no stale reference to thread-A should remain under the parent's key.
    const current = getCachedDeliveryContext(PARENT_KEY);
    expect(current).toBe(THREAD_B);
    expect(current?.threadId).not.toBe("thread-A-1111111111");
  });

  it("does not leak thread-A binding onto unrelated child sessions during rebind", () => {
    const CHILD_KEY = "agent:codex:acp:child-7";
    setCachedDeliveryContext(PARENT_KEY, THREAD_A);
    setCachedDeliveryContext(CHILD_KEY, THREAD_A);

    // Parent rebinds to thread-B; child's own binding is untouched.
    setCachedDeliveryContext(PARENT_KEY, THREAD_B);

    expect(getCachedDeliveryContext(PARENT_KEY)?.threadId).toBe("thread-B-2222222222");
    // The child still carries its own explicit binding (which may be updated
    // independently by its own emission path). We do NOT auto-propagate the
    // parent's new thread to the child — that would invert the ownership
    // model and re-introduce the cross-binding bug Phase 11_B fixed.
    expect(getCachedDeliveryContext(CHILD_KEY)?.threadId).toBe("thread-A-1111111111");
  });

  it("simulates F3 thread-bound final_reply routing through the live cache", () => {
    // Model the read-path used by the F3 direct-post branch in
    // `acp-spawn-parent-stream.ts` and by the announce delivery planner:
    // each call re-reads the cache, so the rebind is visible on the next
    // emission without restarting the relay.
    const resolveLiveSurface = (sessionKey: string) => {
      const ctx = getCachedDeliveryContext(sessionKey);
      if (!ctx?.channel || !ctx?.to) {
        return null;
      }
      return {
        channel: ctx.channel,
        to: ctx.to,
        threadId: ctx.threadId,
      };
    };

    setCachedDeliveryContext(PARENT_KEY, THREAD_A);
    const firstEmit = resolveLiveSurface(PARENT_KEY);
    expect(firstEmit?.threadId).toBe("thread-A-1111111111");

    // Parent's binding moves mid-run.
    setCachedDeliveryContext(PARENT_KEY, THREAD_B);

    // Next emission resolves to the NEW thread.
    const secondEmit = resolveLiveSurface(PARENT_KEY);
    expect(secondEmit?.threadId).toBe("thread-B-2222222222");

    // And no subsequent emission can recover the old thread-A target
    // unless a producer explicitly writes it back — the cache is the
    // sole source of truth on the hot path.
    const thirdEmit = resolveLiveSurface(PARENT_KEY);
    expect(thirdEmit?.threadId).toBe("thread-B-2222222222");
  });

  it("clearing the parent binding mid-run drops emissions to no-surface", () => {
    // A parent that is unbound (e.g. thread archived, binding expired) must
    // not fall back to the previous thread context.
    setCachedDeliveryContext(PARENT_KEY, THREAD_A);
    clearCachedDeliveryContext(PARENT_KEY);
    expect(getCachedDeliveryContext(PARENT_KEY)).toBeUndefined();
  });
});
