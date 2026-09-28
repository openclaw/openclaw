import { afterEach, describe, expect, it, vi } from "vitest";
import { createFaceTimeInitialGreeting } from "../src/talk-initial-greeting.js";

describe("FaceTime initial greeting", () => {
  afterEach(() => vi.useRealTimers());

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
