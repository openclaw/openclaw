import { describe, it, expect } from "vitest";
import {
  extractReferencedDates,
  effectiveDate,
  temporalRelevanceScore,
  computeMemoryScore,
  computeRelativeDateLabel,
} from "../src/tools/temporal-utils.js";

const REF_DATE = new Date("2026-02-27T12:00:00Z");

describe("extractReferencedDates", () => {
  it("extracts ISO dates", () => {
    const dates = extractReferencedDates("Meeting on 2026-02-15 and 2026-03-01", REF_DATE);
    expect(dates).toContain("2026-02-15");
    expect(dates).toContain("2026-03-01");
  });

  it("extracts ISO dates with slashes", () => {
    const dates = extractReferencedDates("Due 2026/01/10", REF_DATE);
    expect(dates).toContain("2026-01-10");
  });

  it("extracts natural language dates: Month Day", () => {
    const dates = extractReferencedDates("Client meeting January 15", REF_DATE);
    expect(dates).toContain("2026-01-15");
  });

  it("extracts natural language dates: Month Day, Year", () => {
    const dates = extractReferencedDates("Deadline: March 1, 2026", REF_DATE);
    expect(dates).toContain("2026-03-01");
  });

  it("extracts abbreviated month names", () => {
    const dates = extractReferencedDates("Jan 5 delivery", REF_DATE);
    expect(dates).toContain("2026-01-05");
  });

  it("extracts Day Month format", () => {
    const dates = extractReferencedDates("15 February 2026", REF_DATE);
    expect(dates).toContain("2026-02-15");
  });

  it("extracts 'yesterday'", () => {
    const dates = extractReferencedDates("Discussed yesterday", REF_DATE);
    expect(dates).toContain("2026-02-26");
  });

  it("extracts 'today'", () => {
    const dates = extractReferencedDates("Due today", REF_DATE);
    expect(dates).toContain("2026-02-27");
  });

  it("extracts 'tomorrow'", () => {
    const dates = extractReferencedDates("Meeting tomorrow", REF_DATE);
    expect(dates).toContain("2026-02-28");
  });

  it("extracts 'last Tuesday'", () => {
    // 2026-02-27 is a Friday, so last Tuesday = 2026-02-24
    const dates = extractReferencedDates("Client meeting last Tuesday", REF_DATE);
    expect(dates).toContain("2026-02-24");
  });

  it("extracts 'N days ago'", () => {
    const dates = extractReferencedDates("Completed 3 days ago", REF_DATE);
    expect(dates).toContain("2026-02-24");
  });

  it("extracts '2 weeks ago'", () => {
    const dates = extractReferencedDates("Started 2 weeks ago", REF_DATE);
    expect(dates).toContain("2026-02-13");
  });

  it("extracts 'last week'", () => {
    const dates = extractReferencedDates("Discussed last week", REF_DATE);
    // Friday = day 5, daysBack = 5 + 7 = 12, 2026-02-27 - 12 = 2026-02-15
    expect(dates).toContain("2026-02-15");
  });

  it("returns empty array for content with no dates", () => {
    const dates = extractReferencedDates("Just a regular note about work", REF_DATE);
    expect(dates).toEqual([]);
  });

  it("handles multiple dates in same content", () => {
    const dates = extractReferencedDates(
      "From 2026-01-01 to 2026-03-31, discussed yesterday",
      REF_DATE,
    );
    expect(dates.length).toBeGreaterThanOrEqual(3);
    expect(dates).toContain("2026-01-01");
    expect(dates).toContain("2026-03-31");
    expect(dates).toContain("2026-02-26");
  });

  it("returns sorted dates", () => {
    const dates = extractReferencedDates("2026-03-01 and 2026-01-15", REF_DATE);
    expect(dates[0]).toBe("2026-01-15");
    expect(dates[1]).toBe("2026-03-01");
  });

  it("deduplicates dates", () => {
    const dates = extractReferencedDates("2026-02-15 and February 15", REF_DATE);
    const count = dates.filter((d) => d === "2026-02-15").length;
    expect(count).toBe(1);
  });
});

describe("effectiveDate", () => {
  it("returns observed_at when present", () => {
    expect(effectiveDate({ observed_at: "2026-02-20", created_at: "2026-02-27" })).toBe(
      "2026-02-20",
    );
  });

  it("falls back to created_at", () => {
    expect(effectiveDate({ created_at: "2026-02-27" })).toBe("2026-02-27");
  });
});

describe("temporalRelevanceScore", () => {
  it("scores high for items matching query dates", () => {
    const item = {
      observed_at: "2026-02-15",
      created_at: "2026-02-27",
      referenced_dates: ["2026-02-15"],
    };
    const score = temporalRelevanceScore(item, "what happened on February 15", REF_DATE);
    expect(score).toBeGreaterThan(0.8);
  });

  it("scores low for items far from query dates", () => {
    const item = {
      observed_at: "2025-06-01",
      created_at: "2026-02-27",
      referenced_dates: ["2025-06-01"],
    };
    const score = temporalRelevanceScore(item, "what happened yesterday", REF_DATE);
    expect(score).toBeLessThan(0.3);
  });

  it("uses recency when no query dates", () => {
    const recent = {
      created_at: "2026-02-26T12:00:00Z",
    };
    const old = {
      created_at: "2026-01-01T12:00:00Z",
    };
    const recentScore = temporalRelevanceScore(recent, undefined, REF_DATE);
    const oldScore = temporalRelevanceScore(old, undefined, REF_DATE);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("returns low score for items with no parseable dates when query has dates", () => {
    const item = {
      created_at: "invalid",
    };
    const score = temporalRelevanceScore(item, "what happened yesterday", REF_DATE);
    expect(score).toBe(0.1);
  });
});

describe("computeMemoryScore", () => {
  it("uses semantic weight when semanticScore provided", () => {
    const item = {
      importance: 0.8,
      created_at: "2026-02-27T12:00:00Z",
      observed_at: "2026-02-27",
    };
    const withSemantic = computeMemoryScore({ item, semanticScore: 0.9, queryDate: REF_DATE });
    const withoutSemantic = computeMemoryScore({ item, queryDate: REF_DATE });
    // With semantic should weight semantic*0.5 + importance*0.2 + temporal*0.3
    expect(withSemantic).toBeGreaterThan(0.5);
    expect(withSemantic).not.toBe(withoutSemantic);
  });

  it("uses importance + temporal when no semantic", () => {
    const item = {
      importance: 1.0,
      created_at: "2026-02-27T12:00:00Z",
    };
    const score = computeMemoryScore({ item, queryDate: REF_DATE });
    // importance*0.4 + temporal*0.4 + freshness*0.2 — all should be near 1.0
    expect(score).toBeGreaterThan(0.8);
  });
});

describe("computeRelativeDateLabel", () => {
  it("returns 'today' for same day", () => {
    expect(computeRelativeDateLabel("2026-02-27", REF_DATE)).toBe("today");
  });

  it("returns 'yesterday' for 1 day ago", () => {
    expect(computeRelativeDateLabel("2026-02-26", REF_DATE)).toBe("yesterday");
  });

  it("returns 'N days ago' for <7 days", () => {
    expect(computeRelativeDateLabel("2026-02-24", REF_DATE)).toBe("3 days ago");
  });

  it("returns 'last week' for 7-13 days", () => {
    expect(computeRelativeDateLabel("2026-02-18", REF_DATE)).toBe("last week");
  });

  it("returns 'N weeks ago' for 14-29 days", () => {
    expect(computeRelativeDateLabel("2026-02-10", REF_DATE)).toBe("2 weeks ago");
  });

  it("returns future label for future dates", () => {
    expect(computeRelativeDateLabel("2026-03-01", REF_DATE)).toBe("in 2 days");
  });

  it("handles invalid dates", () => {
    expect(computeRelativeDateLabel("not-a-date", REF_DATE)).toBe("unknown date");
  });
});
