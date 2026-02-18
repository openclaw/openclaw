import { describe, expect, it } from "vitest";

// Isolated unit test for the startupGraceMs clock-skew guard logic
// extracted from createMatrixRoomMessageHandler.

function shouldDropEvent(opts: {
  eventTs: number | undefined;
  eventAge: number | undefined;
  startupMs: number;
  startupGraceMs: number;
}): boolean {
  const { eventTs, eventAge, startupMs, startupGraceMs } = opts;
  if (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) {
    return true;
  }
  if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > startupGraceMs) {
    return true;
  }
  return false;
}

describe("Matrix startupGraceMs clock-skew guard", () => {
  const now = Date.now();

  it("drops genuinely old events (older than grace window)", () => {
    expect(
      shouldDropEvent({
        eventTs: now - 10_000,
        eventAge: undefined,
        startupMs: now,
        startupGraceMs: 5_000,
      }),
    ).toBe(true);
  });

  it("accepts events within the 5s grace window (clock skew tolerance)", () => {
    // Server clock is 3s behind — eventTs appears 3s before our startupMs
    expect(
      shouldDropEvent({
        eventTs: now - 3_000,
        eventAge: undefined,
        startupMs: now,
        startupGraceMs: 5_000,
      }),
    ).toBe(false);
  });

  it("drops all events with grace=0 when server clock is even 1ms behind (regression)", () => {
    expect(
      shouldDropEvent({ eventTs: now - 1, eventAge: undefined, startupMs: now, startupGraceMs: 0 }),
    ).toBe(true);
  });

  it("accepts fresh events regardless of grace window", () => {
    expect(
      shouldDropEvent({
        eventTs: now + 500,
        eventAge: undefined,
        startupMs: now,
        startupGraceMs: 5_000,
      }),
    ).toBe(false);
  });

  it("drops events with no timestamp when age exceeds grace window", () => {
    expect(
      shouldDropEvent({
        eventTs: undefined,
        eventAge: 10_000,
        startupMs: now,
        startupGraceMs: 5_000,
      }),
    ).toBe(true);
  });

  it("accepts events with no timestamp when age is within grace window", () => {
    expect(
      shouldDropEvent({
        eventTs: undefined,
        eventAge: 2_000,
        startupMs: now,
        startupGraceMs: 5_000,
      }),
    ).toBe(false);
  });
});
