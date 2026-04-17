import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  hasResumedAnnounceExpired,
} from "./subagent-registry-helpers.js";

describe("hasResumedAnnounceExpired", () => {
  it("expires normal resumed announces after the standard expiry window", () => {
    const now = 1_000_000;
    expect(
      hasResumedAnnounceExpired(
        {
          endedAt: now - ANNOUNCE_EXPIRY_MS - 1,
          expectsCompletionMessage: false,
        },
        now,
      ),
    ).toBe(true);
    expect(
      hasResumedAnnounceExpired(
        {
          endedAt: now - ANNOUNCE_EXPIRY_MS + 1,
          expectsCompletionMessage: false,
        },
        now,
      ),
    ).toBe(false);
  });

  it("gives completion-message announces a longer hard expiry window", () => {
    const now = 2_000_000;
    expect(
      hasResumedAnnounceExpired(
        {
          endedAt: now - ANNOUNCE_EXPIRY_MS - 1,
          expectsCompletionMessage: true,
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasResumedAnnounceExpired(
        {
          endedAt: now - ANNOUNCE_COMPLETION_HARD_EXPIRY_MS - 1,
          expectsCompletionMessage: true,
        },
        now,
      ),
    ).toBe(true);
  });

  it("does not expire runs without a terminal endedAt", () => {
    expect(hasResumedAnnounceExpired({ expectsCompletionMessage: true }, 3_000_000)).toBe(false);
  });
});
