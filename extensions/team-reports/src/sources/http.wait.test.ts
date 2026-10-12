import { afterEach, describe, expect, it, vi } from "vitest";
import { wait } from "./http.js";

describe("team-reports source wait", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a long reset delay on the monotonic clock across a wall-clock jump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const pending = wait(5_000, undefined, "reset");

    await vi.advanceTimersByTimeAsync(1_000);
    // NTP correction or resume from sleep. A wall-clock deadline would treat the
    // remaining budget as already spent and resolve after ~1000ms of real waiting.
    vi.spyOn(Date, "now").mockReturnValue(300_000);

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(3_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });
});
