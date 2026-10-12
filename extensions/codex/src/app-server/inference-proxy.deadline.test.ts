// Regression proof for the native inference WebSocket handshake deadline clock
// domain (BUG-100). The WS upgrade handler seeds its handshake deadline from the
// wall clock (Date.now() + HANDSHAKE_TIMEOUT_MS) and derives the remaining budget
// it hands to the upstream WebSocket handshakeTimeout and the relay setTimeout.
// A wall-clock rewind (NTP correction / sleep resume) between the seed and a later
// remaining read would inflate that budget far beyond HANDSHAKE_TIMEOUT_MS,
// stalling the native inference handshake; the monotonic counterpart
// (deadlineAtMonotonicMs, performance.now()) does not.
//
// Two proofs drive the real inference proxy (real WS transport / real upstream
// handshake via the capacity test-support harness):
//  1. A wall-clock rewind *before the relay timer is armed* (the case ClawSweeper
//     flagged) keeps the armed relay timer at ~10s: the client-visible HTTP 504
//     still fires on schedule and the connection is cleaned up. Pre-fix the armed
//     timer would be inflated to ~130s and no 504 would fire here.
//  2. The production-boundary real proof (real relay + real transport client on
//     the native clock) lives in bug-100-real-proof.ts, not in this suite.
import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, transport } from "./inference-proxy.capacity-test-support.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

describe("inference relay WebSocket handshake deadline clock domain", () => {
  const realDateNow = Date.now;

  afterEach(() => {
    // Never leak a skewed wall clock or monotonic spy into a later test.
    Date.now = realDateNow;
    vi.spyOn(performance, "now").mockRestore();
    vi.useRealTimers();
  });

  it("arms the relay timeout at ~10s (not ~130s) when the wall clock rewinds before arming, and expires 504", async () => {
    // Real WS transport, real upstream handshake, fake timers so the armed relay
    // timer fires deterministically. The wall clock rewinds between the deadline
    // seed (Date.now()) and the relay timer arming (remaining = deadline -
    // Date.now() pre-fix; deadline - performance.now() post-fix). The fix keeps
    // the armed timer at ~10s; pre-fix the rewind inflates it to ~130s and the
    // client would hang well past this window.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Seed the deadline from the real wall clock, then rewind Date.now for every
    // read afterwards — i.e. a 120s rewind between the deadline seed (top of the
    // upgrade handler) and the relay timer arming.
    const rewoundAt = realDateNow() - 120_000;
    let seeded = false;
    Date.now = () => {
      if (!seeded) {
        seeded = true;
        return realDateNow();
      }
      return rewoundAt;
    };

    // Stall DNS so we have a stable point to observe the client-side expiry, and
    // to exercise connection cleanup.
    const started = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      started.resolve();
      return dns.promise;
    });

    const stalled = connect();
    const rejected = once(stalled, "unexpected-response");
    await started.promise;

    // Advance the fake timer past the 10s handshake budget. Post-fix the armed
    // relay timer fires here and the client sees a 504. Pre-fix the timer was
    // armed at ~130s (deadline - Date.now() with the rewound clock) so no 504
    // fires within this window.
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 100);

    const [, response] = await rejected;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(504);

    // Release the stalled DNS so the permit is not leaked. The upgrade was
    // rejected (unexpected-response already fired), which is the cleanup the
    // client observes.
    dns.resolve({ lookup: undefined });
  });
});
