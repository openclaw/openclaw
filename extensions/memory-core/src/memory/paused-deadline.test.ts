import { afterEach, describe, expect, it, vi } from "vitest";
import { createPausedDeadline } from "./paused-deadline.js";

function createControl() {
  const listeners = new Set<(action: "pause" | "resume") => void>();
  return {
    subscribe(listener: (action: "pause" | "resume") => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report(action: "pause" | "resume") {
      for (const listener of listeners) {
        listener(action);
      }
    },
  };
}

describe("createPausedDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not treat a wall-clock jump as an expired embedding pause budget", () => {
    vi.useFakeTimers();
    const wall = Date.now();
    const controller = new AbortController();
    let expired = false;
    const deadline = createPausedDeadline({
      kind: "embedding",
      timeoutMs: 5_000,
      signal: controller.signal,
      expire: () => {
        expired = true;
      },
    });
    deadline.start();
    vi.spyOn(Date, "now").mockReturnValue(wall + 120_000);
    expect(deadline.isExpired()).toBe(false);
    expect(expired).toBe(false);
    deadline.close();
  });

  it("keeps remaining embedding budget when pause accounting sees a wall-clock jump", () => {
    vi.useFakeTimers();
    let mono = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => mono);
    const wall = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(wall);
    const controller = new AbortController();
    let expired = false;
    const control = createControl();
    const deadline = createPausedDeadline({
      kind: "embedding",
      timeoutMs: 10_000,
      signal: controller.signal,
      control,
      expire: () => {
        expired = true;
      },
    });
    deadline.start();
    mono += 1_000;
    vi.spyOn(Date, "now").mockReturnValue(wall + 120_000);
    control.report("pause");
    expect(expired).toBe(false);
    control.report("resume");
    expect(deadline.isExpired()).toBe(false);
    deadline.close();
  });
});
