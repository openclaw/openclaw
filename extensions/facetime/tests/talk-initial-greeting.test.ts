import { afterEach, describe, expect, it, vi } from "vitest";
import { createFaceTimeInitialGreeting } from "../src/talk-initial-greeting.js";

describe("FaceTime initial greeting", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the carrier media settle window and schedules only once", async () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const greeting = createFaceTimeInitialGreeting({ delayMs: 750, speak });

    greeting.schedule();
    greeting.schedule();
    await vi.advanceTimersByTimeAsync(749);
    expect(speak).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(speak).toHaveBeenCalledOnce();
  });

  it("does not talk over a caller who speaks during the settle window", async () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const greeting = createFaceTimeInitialGreeting({ delayMs: 750, speak });

    greeting.schedule();
    greeting.cancel();
    await vi.advanceTimersByTimeAsync(750);

    expect(speak).not.toHaveBeenCalled();
  });
});
