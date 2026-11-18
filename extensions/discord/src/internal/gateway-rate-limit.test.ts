import { expect, it, vi } from "vitest";
import { GatewaySendLimiter } from "./gateway-rate-limit.js";

it("bounds retained send timestamps during idle heartbeat traffic", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const limiter = new GatewaySendLimiter(send, vi.fn(), vi.fn());
  try {
    for (let index = 0; index < 240; index += 1) {
      vi.setSystemTime(index * 45_000);
      limiter.send('{"op":1,"d":null}', { critical: true });
    }
    expect(send).toHaveBeenCalledTimes(240);
    // Rate accounting retains only the two heartbeats in the current minute.
    expect(limiter).toHaveProperty("outboundSendTimestamps.length", 2);
  } finally {
    limiter.clear();
    vi.useRealTimers();
  }
});
