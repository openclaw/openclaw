import { describe, expect, it } from "vitest";
import type { UsageEntry, UsageFile } from "../src/telemetry.js";
import {
  determineTransition,
  determineAllTransitions,
  daysSinceLastUse,
} from "../src/transitions.js";
import type { TransitionThresholds } from "../src/transitions.js";

const DEFAULT_THRESHOLDS: TransitionThresholds = {
  stale_after_days: 30,
  archive_after_days: 90,
};

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    name: "test-skill",
    view_count: 0,
    use_count: 0,
    patch_count: 0,
    last_viewed_at: null,
    last_used_at: null,
    last_patched_at: null,
    pinned: false,
    created_at: "2026-01-01T00:00:00.000Z",
    source: "agent-created",
    state: "active",
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("transitions", () => {
  describe("daysSinceLastUse", () => {
    it("returns the correct number of days since last_used_at", () => {
      const entry = makeEntry({ last_used_at: daysAgo(10) });
      const now = new Date();
      const days = daysSinceLastUse(entry, now);
      expect(days).toBeCloseTo(10, 0);
    });

    it("falls back to created_at when last_used_at is null", () => {
      const entry = makeEntry({
        last_used_at: null,
        created_at: daysAgo(50),
      });
      const now = new Date();
      const days = daysSinceLastUse(entry, now);
      expect(days).toBeCloseTo(50, 0);
    });
  });

  describe("determineTransition", () => {
    it("returns no action for recently used skill", () => {
      const entry = makeEntry({ last_used_at: daysAgo(5) });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("none");
      expect(result.newState).toBe("active");
    });

    it("marks stale after stale_after_days", () => {
      const entry = makeEntry({ last_used_at: daysAgo(35) });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("mark_stale");
      expect(result.newState).toBe("stale");
      expect(result.daysSinceUsed).toBeCloseTo(35, 0);
    });

    it("archives after archive_after_days", () => {
      const entry = makeEntry({ last_used_at: daysAgo(100) });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("archive");
      expect(result.newState).toBe("archived");
    });

    it("archives a stale skill after archive_after_days", () => {
      const entry = makeEntry({
        last_used_at: daysAgo(95),
        state: "stale",
      });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("archive");
      expect(result.newState).toBe("archived");
    });

    it("skips pinned skills (no transition)", () => {
      const entry = makeEntry({
        last_used_at: daysAgo(200),
        pinned: true,
      });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("none");
      expect(result.newState).toBe("active"); // stays whatever it was
    });

    it("leaves already-archived skills as archived", () => {
      const entry = makeEntry({
        last_used_at: daysAgo(200),
        state: "archived",
      });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("none");
      expect(result.newState).toBe("archived");
    });

    it("custom thresholds are respected", () => {
      const customThresholds: TransitionThresholds = {
        stale_after_days: 7,
        archive_after_days: 14,
      };

      const entry10d = makeEntry({ last_used_at: daysAgo(10) });
      const result10d = determineTransition(entry10d, customThresholds);
      expect(result10d.action).toBe("mark_stale");

      const entry20d = makeEntry({ last_used_at: daysAgo(20) });
      const result20d = determineTransition(entry20d, customThresholds);
      expect(result20d.action).toBe("archive");
    });

    it("returns no action at exact boundary (not > threshold)", () => {
      // Exactly 30 days — day boundary is not > 30, so no action
      const entry = makeEntry({
        last_used_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      // At exactly 30 days, daysSinceUsed should be ~30, which is NOT > 30
      expect(result.action).toBe("none");
    });

    it("returns mark_stale just past the stale boundary", () => {
      // 30 days + 1 hour
      const entry = makeEntry({
        last_used_at: new Date(Date.now() - (30 * 24 + 1) * 60 * 60 * 1000).toISOString(),
      });
      const result = determineTransition(entry, DEFAULT_THRESHOLDS);
      expect(result.action).toBe("mark_stale");
    });
  });

  describe("determineAllTransitions", () => {
    it("returns only entries requiring action", () => {
      const skills: UsageFile["skills"] = {
        "fresh-skill": makeEntry({
          name: "fresh-skill",
          last_used_at: daysAgo(5),
        }),
        "stale-skill": makeEntry({
          name: "stale-skill",
          last_used_at: daysAgo(45),
        }),
        "archive-skill": makeEntry({
          name: "archive-skill",
          last_used_at: daysAgo(120),
        }),
        "pinned-old": makeEntry({
          name: "pinned-old",
          last_used_at: daysAgo(200),
          pinned: true,
        }),
        "already-archived": makeEntry({
          name: "already-archived",
          last_used_at: daysAgo(200),
          state: "archived",
        }),
      };

      const results = determineAllTransitions(skills, DEFAULT_THRESHOLDS);
      expect(results).toHaveLength(2);

      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(["archive-skill", "stale-skill"]);

      const staleResult = results.find((r) => r.name === "stale-skill")!;
      expect(staleResult.result.action).toBe("mark_stale");

      const archiveResult = results.find((r) => r.name === "archive-skill")!;
      expect(archiveResult.result.action).toBe("archive");
    });

    it("skips bundled and hub-installed skills", () => {
      const skills: UsageFile["skills"] = {
        "bundled-skill": makeEntry({
          name: "bundled-skill",
          last_used_at: daysAgo(200),
          source: "bundled",
        }),
        "hub-skill": makeEntry({
          name: "hub-skill",
          last_used_at: daysAgo(200),
          source: "hub",
        }),
        "agent-skill": makeEntry({
          name: "agent-skill",
          last_used_at: daysAgo(200),
          source: "agent-created",
        }),
      };

      const results = determineAllTransitions(skills, DEFAULT_THRESHOLDS);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("agent-skill");
    });

    it("returns empty array when no transitions needed", () => {
      const skills: UsageFile["skills"] = {
        fresh: makeEntry({ name: "fresh", last_used_at: daysAgo(1) }),
      };
      const results = determineAllTransitions(skills, DEFAULT_THRESHOLDS);
      expect(results).toHaveLength(0);
    });
  });
});
