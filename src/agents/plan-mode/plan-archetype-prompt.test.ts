/**
 * PR-10: Tests for plan-archetype prompt fragment + filename helpers.
 */
import { describe, expect, test } from "vitest";
import {
  buildPlanFilename,
  buildPlanFilenameSlug,
  PLAN_ARCHETYPE_PROMPT,
} from "./plan-archetype-prompt.js";

describe("PLAN_ARCHETYPE_PROMPT", () => {
  test("includes the decision-complete plan standard heading", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("Decision-Complete Plan Standard");
  });

  test("calls out the required exit_plan_mode fields by name", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("title");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("summary");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("analysis");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("plan");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("assumptions");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("risks");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("verification");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("references");
  });

  test("warns against ack-only / chat-narration title (item #1 user feedback)", () => {
    expect(PLAN_ARCHETYPE_PROMPT.toLowerCase()).toContain(
      "title that's actually the agent's chat narration",
    );
  });

  test("clarifies ask_user_question does NOT exit plan mode", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("Questions DO NOT exit plan mode");
  });

  test("encourages multi-page plans (no upper length cap)", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toMatch(/no upper limit|Multi-page|10 pages/);
  });
});

describe("buildPlanFilenameSlug", () => {
  test("kebab-cases ASCII titles", () => {
    expect(buildPlanFilenameSlug("Fix WebSocket reconnect race")).toBe(
      "fix-websocket-reconnect-race",
    );
  });

  test("strips diacritics", () => {
    expect(buildPlanFilenameSlug("Café résumé piñata")).toBe("cafe-resume-pinata");
  });

  test("collapses runs of non-alphanumeric chars to single hyphens", () => {
    expect(buildPlanFilenameSlug("foo!!bar??baz")).toBe("foo-bar-baz");
  });

  test("trims leading/trailing hyphens", () => {
    expect(buildPlanFilenameSlug("---hello---")).toBe("hello");
  });

  test("respects maxLen and trims trailing hyphen left by truncation", () => {
    const long = "this-is-a-very-long-title-with-many-words-and-extra-text";
    const slug = buildPlanFilenameSlug(long, 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug.endsWith("-")).toBe(false);
  });

  test('falls back to "untitled" for empty / whitespace input', () => {
    expect(buildPlanFilenameSlug("")).toBe("untitled");
    expect(buildPlanFilenameSlug("   ")).toBe("untitled");
    expect(buildPlanFilenameSlug(undefined)).toBe("untitled");
  });

  test('falls back to "untitled" when sanitization produces empty string', () => {
    // Pure punctuation collapses to nothing.
    expect(buildPlanFilenameSlug("!!!???")).toBe("untitled");
  });
});

describe("buildPlanFilename", () => {
  test("uses ISO YYYY-MM-DD date prefix + slug + .md suffix", () => {
    const date = new Date("2026-04-17T15:30:00Z");
    expect(buildPlanFilename("Fix WebSocket reconnect", date)).toBe(
      "plan-2026-04-17-fix-websocket-reconnect.md",
    );
  });

  test('falls back to "untitled" slug when title is empty', () => {
    const date = new Date("2026-04-17T00:00:00Z");
    expect(buildPlanFilename(undefined, date)).toBe("plan-2026-04-17-untitled.md");
  });

  test("filenames sort chronologically by date prefix (cache + history scan)", () => {
    const day1 = buildPlanFilename("alpha", new Date("2026-04-15T00:00:00Z"));
    const day2 = buildPlanFilename("alpha", new Date("2026-04-16T00:00:00Z"));
    const day3 = buildPlanFilename("alpha", new Date("2026-04-17T00:00:00Z"));
    const sorted = [day3, day1, day2].toSorted();
    expect(sorted).toEqual([day1, day2, day3]);
  });
});
