// Tests for subagent session reconciliation — completion inference from persisted session entries.
import { describe, expect, it } from "vitest";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

const NOW = 1_700_000_000_000;
const RECENT_MS = NOW - 5_000;
const FRESH_MS = NOW - 1_000;
const STALE_MS = NOW - 120_000;

describe("resolveCompletionFromSessionEntry", () => {
  it("detects done sessions", () => {
    const result = resolveCompletionFromSessionEntry(
      { status: "done", endedAt: RECENT_MS, updatedAt: RECENT_MS },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("ok");
  });

  it("detects failed sessions", () => {
    const result = resolveCompletionFromSessionEntry(
      { status: "failed", endedAt: RECENT_MS, updatedAt: RECENT_MS },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("error");
  });

  it("detects killed sessions", () => {
    const result = resolveCompletionFromSessionEntry(
      { status: "killed", endedAt: RECENT_MS, updatedAt: RECENT_MS },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("error");
  });

  it("detects timeout sessions", () => {
    const result = resolveCompletionFromSessionEntry(
      { status: "timeout", endedAt: RECENT_MS, updatedAt: RECENT_MS },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("timeout");
  });

  it("returns null for still-active running sessions without endedAt", () => {
    const result = resolveCompletionFromSessionEntry(
      { status: "running" },
      NOW,
    );
    expect(result).toBeNull();
  });

  it("detects archived running sessions that have an endedAt timestamp", () => {
    // Regression test for #90299: sessions archived before status was updated
    // from "running" to "done" should still be recognized as completed.
    const result = resolveCompletionFromSessionEntry(
      { status: "running", endedAt: RECENT_MS, updatedAt: RECENT_MS },
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("ok");
    expect(result!.reason).toBe("complete");
  });

  it("respects notBeforeMs for archived running sessions", () => {
    // A stale archived session should not be detected if its endedAt
    // is before the notBeforeMs threshold.
    const result = resolveCompletionFromSessionEntry(
      { status: "running", endedAt: STALE_MS, updatedAt: STALE_MS },
      NOW,
      { notBeforeMs: RECENT_MS },
    );
    expect(result).toBeNull();
  });

  it("detects archived running sessions within the notBeforeMs window", () => {
    const result = resolveCompletionFromSessionEntry(
      {
        status: "running",
        endedAt: FRESH_MS,
        updatedAt: FRESH_MS,
        startedAt: FRESH_MS,
      },
      NOW,
      { notBeforeMs: RECENT_MS },
    );
    expect(result).not.toBeNull();
    expect(result!.outcome.status).toBe("ok");
  });
});
