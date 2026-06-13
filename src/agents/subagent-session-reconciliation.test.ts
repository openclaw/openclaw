// Subagent session reconciliation tests cover persisted-status completion
// mapping, including the blocked terminal status.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

function entry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "sess-child",
    updatedAt: 2_000,
    ...overrides,
  } as SessionEntry;
}

describe("resolveCompletionFromSessionEntry", () => {
  it("maps blocked sessions to an error completion", () => {
    const completion = resolveCompletionFromSessionEntry(
      entry({ status: "blocked", startedAt: 1_000, endedAt: 1_900 }),
      3_000,
    );
    expect(completion).toEqual({
      startedAt: 1_000,
      endedAt: 1_900,
      outcome: { status: "error", error: "subagent run ended blocked" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
    });
  });

  it("ignores blocked completions older than the current run", () => {
    expect(
      resolveCompletionFromSessionEntry(entry({ status: "blocked", endedAt: 1_900 }), 3_000, {
        notBeforeMs: 2_500,
      }),
    ).toBeNull();
  });

  it("keeps running rows without endedAt unresolved", () => {
    expect(resolveCompletionFromSessionEntry(entry({ status: "running" }), 3_000)).toBeNull();
  });
});
