import { describe, expect, it, vi } from "vitest";
import {
  isLiveUnendedSubagentRun,
  isStaleUnendedSubagentRun,
  STALE_UNENDED_SUBAGENT_RUN_MS,
} from "./subagent-run-liveness.js";

describe("subagent run liveness", () => {
  const now = Date.parse("2026-04-25T12:00:00Z");

  it("keeps fresh unended runs live", () => {
    const entry = {
      createdAt: now - 60_000,
    };
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("marks old unended runs stale when no explicit timeout extends the window", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(true);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("does not mark ended runs stale", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      endedAt: now - 1,
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(false);
  });

  it("uses sessionStartedAt ahead of createdAt", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      sessionStartedAt: now - 60_000,
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("extends stale cutoff for explicit long run timeouts", () => {
    const entry = {
      createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
      runTimeoutSeconds: 6 * 60 * 60,
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("ignores non-real fixture timestamps as unknown instead of stale", () => {
    const entry = {
      createdAt: 100,
    };
    expect(isStaleUnendedSubagentRun(entry, now)).toBe(false);
    expect(isLiveUnendedSubagentRun(entry, now)).toBe(true);
  });

  it("defaults to current time when now is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect(
        isStaleUnendedSubagentRun({
          createdAt: now - STALE_UNENDED_SUBAGENT_RUN_MS - 1,
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
