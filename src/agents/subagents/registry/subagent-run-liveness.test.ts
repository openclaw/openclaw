// Subagent run liveness tests cover stale-unended detection and child-link
// retention windows for registry list/read paths.
import { describe, expect, it, vi } from "vitest";
import {
  isRetainedUnendedSubagentRun,
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  isStaleUnendedSubagentRun,
  shouldKeepSubagentRunChildLink,
} from "./subagent-run-liveness.js";

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;

describe("subagent run liveness", () => {
  const now = Date.parse("2026-04-25T12:00:00Z");

  it("retains fresh unowned registrations for the bounded grace period", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - 60_000,
      execution: {},
    };
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("marks old unended runs stale when no explicit timeout extends the window", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(true);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("does not mark ended runs stale", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      execution: { endedAt: now - 1 },
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("uses sessionStartedAt ahead of createdAt", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      sessionStartedAt: now - 60_000,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("extends stale cutoff for explicit long run timeouts", () => {
    const entry = {
      runId: "unowned-retention-row",
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      runTimeoutSeconds: 6 * 60 * 60,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("ignores non-real fixture timestamps as unknown instead of stale", () => {
    // Small fixture timestamps appear in tests and old synthetic records; they
    // should not be interpreted as Unix epoch production runs.
    const entry = {
      runId: "unowned-retention-row",
      createdAt: 100,
      execution: {},
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isRetainedUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("defaults to current time when now is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect(
        isStaleUnendedSubagentRun({
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
          execution: {},
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps child links during registration grace, recent completion, or pending descendants", () => {
    expect(
      shouldKeepSubagentRunChildLink(
        { runId: "unowned-retention-row", createdAt: now - 60_000, execution: {} },
        { now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS + 1 },
        },
        { now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { now },
      ),
    ).toBe(false);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 60_000,
          execution: { endedAt: now - RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS - 1 },
        },
        { activeDescendants: 1, now },
      ),
    ).toBe(true);
    expect(
      shouldKeepSubagentRunChildLink(
        {
          runId: "unowned-retention-row",
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
          execution: {},
        },
        { now },
      ),
    ).toBe(false);
  });
});
