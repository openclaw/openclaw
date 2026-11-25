// Irc tests cover reconnect backoff plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIrcReconnectBackoff } from "./reconnect-backoff.js";

describe("irc reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([0, -3_600_000, 3_600_000])(
    "resets after a minute despite a %dms wall-clock step",
    (step) => {
      const backoff = createIrcReconnectBackoff();
      backoff.nextDelayMs();
      backoff.nextDelayMs();
      expect(backoff.nextDelayMs()).toBe(4_000);
      backoff.markConnected();
      vi.advanceTimersByTime(60_000);
      vi.setSystemTime(Date.now() + step);
      expect(backoff.nextDelayMs()).toBe(1_000);
    },
  );

  it.each([0, -3_600_000, 3_600_000])(
    "does not reset before the threshold despite a %dms wall-clock step",
    (step) => {
      const backoff = createIrcReconnectBackoff();
      backoff.nextDelayMs();
      backoff.markConnected();
      vi.advanceTimersByTime(59_999);
      vi.setSystemTime(Date.now() + step);
      expect(backoff.nextDelayMs()).toBe(2_000);
    },
  );

  it("does not let a failed connect attempt inherit an earlier connection's uptime", () => {
    const backoff = createIrcReconnectBackoff();
    backoff.nextDelayMs();
    backoff.markConnected();
    vi.advanceTimersByTime(10_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    vi.advanceTimersByTime(120_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
  });
});
