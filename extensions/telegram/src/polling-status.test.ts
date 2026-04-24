import { describe, expect, it, vi } from "vitest";
import { createTelegramPollingStatusPublisher } from "./polling-status.js";

describe("createTelegramPollingStatusPublisher", () => {
  it("publishes start, successful poll, and stop status patches", () => {
    const setStatus = vi.fn();
    const status = createTelegramPollingStatusPublisher(setStatus);

    status.notePollingStart();
    status.notePollSuccess(1234);
    status.notePollingStop();

    expect(setStatus).toHaveBeenNthCalledWith(1, {
      mode: "polling",
      lastConnectedAt: null,
      lastEventAt: null,
      lastTransportActivityAt: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      mode: "polling",
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
      lastTransportActivityAt: 1234,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(3, {
      mode: "polling",
      connected: false,
    });
  });

  it("notePollingStart does not carry a connected:false flag", () => {
    // Regression: writing connected:false on every cycle start caused the gateway
    // health monitor to restart busy telegram bots on a 10-minute cadence when the
    // grammY startup handshake ran past the previous 120s connect grace window
    // (now widened to 300s as a defense-in-depth in channel-health-policy).
    const setStatus = vi.fn();
    const status = createTelegramPollingStatusPublisher(setStatus);

    status.notePollingStart();

    const [patch] = setStatus.mock.calls[0] ?? [];
    expect(patch).toBeDefined();
    expect(patch as Record<string, unknown>).not.toHaveProperty("connected");
  });
});
