import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, transport } from "./inference-proxy.capacity-test-support.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

describe("inference relay WebSocket handshake deadline clock domain", () => {
  const realDateNow = Date.now;

  afterEach(() => {
    vi.restoreAllMocks();
    Date.now = realDateNow;
    vi.useRealTimers();
  });

  it("expires with 504 on elapsed time when the wall clock rewinds before arming", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Shift after the deadline seed, before its remaining budget is calculated.
    const rewoundAt = realDateNow() - 120_000;
    let seeded = false;
    Date.now = () => {
      if (!seeded) {
        seeded = true;
        return realDateNow();
      }
      return rewoundAt;
    };

    // Hold DNS while the relay timeout expires.
    const started = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      started.resolve();
      return dns.promise;
    });

    const stalled = connect();
    const rejected = once(stalled, "unexpected-response");
    await started.promise;

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 100);

    const [, response] = await rejected;
    response.resume();
    expect(response.statusCode).toBe(504);

    dns.resolve({ lookup: undefined });
  });

  it.each(["open", "failure"] as const)(
    "preserves %s after a forward clock jump during DNS",
    async (outcome) => {
      transport.resolve.mockImplementationOnce(async () => {
        vi.spyOn(Date, "now").mockReturnValue(realDateNow() + 2 * 60 * 60 * 1000);
        if (outcome === "failure") {
          throw new Error("DNS unavailable");
        }
        return { lookup: undefined };
      });
      const client = connect();
      if (outcome === "open") {
        await once(client, "open");
      } else {
        const [, response] = await once(client, "unexpected-response");
        response.resume();
        expect(response.statusCode).toBe(502);
      }
    },
  );
});
