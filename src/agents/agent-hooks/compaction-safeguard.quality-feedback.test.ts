import { describe, expect, it } from "vitest";
import {
  auditSummaryQuality,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";

const LATEST_ASK = "report the deployment status";
const MISSING_IDENTIFIERS_PREFIX = "missing_identifiers:";
// Twelve distinct 700-char URLs exceed the 4k wrapper; only four fit the 3,400-char budget.
const LONG_IDENTIFIERS = Array.from({ length: 12 }, (_, index) =>
  `https://example.com/paths/segment-${index}/`.padEnd(700, "x"),
);
const SHORT_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) => `abc${String(index).padStart(2, "0")}def12345`,
);
const BUDGET_FILLING_IDENTIFIERS = [
  "https://example.com/fill/".padEnd(3400, "f"),
  ...Array.from({ length: 11 }, (_, index) => `id-${String(index).padStart(2, "0")}`),
];
const qualityFeedback = (reasons: string[]) =>
  `Previous summary failed quality checks (${reasons.join(", ")}).`;
const wrapQualityFeedback = (reasons: string[]) =>
  wrapUntrustedInstructionBlock("Quality check feedback", qualityFeedback(reasons));

function namedMissingIdentifiers(reasons: string[]): string[] {
  const listed = reasons.find((reason) => reason.startsWith(MISSING_IDENTIFIERS_PREFIX));
  return listed ? listed.slice(MISSING_IDENTIFIERS_PREFIX.length).split(",") : [];
}

// Duplicate/missing headings plus an unresolved retained ask drive all co-occurring reasons.
const auditWorstCase = (identifiers: string[]) =>
  auditSummaryQuality({
    summary: "Nothing preserved.",
    structuralSummary: "Nothing preserved.",
    sourceSummaries: [
      ["Decisions", "Open TODOs", "Constraints/Rules", "Pending user asks", "Exact identifiers"]
        .map((heading) => `## ${heading}\n## ${heading}`)
        .join("\n"),
    ],
    identifiers,
    latestAsk: LATEST_ASK,
    latestUnresolvedUserRequest: LATEST_ASK,
    retainedTurnSummary: `## Pending user asks\n${LATEST_ASK}`,
  }).reasons;

describe("compaction-safeguard corrective quality feedback", () => {
  it("keeps whole identifiers and the worst-case defect list inside the feedback block", () => {
    const reasons = auditWorstCase(LONG_IDENTIFIERS);
    expect(namedMissingIdentifiers(reasons)).toStrictEqual(LONG_IDENTIFIERS.slice(0, 4));
    expect(reasons).toContain("missing_identifiers_omitted:8");
    expect(reasons.length).toBeGreaterThanOrEqual(13);
    expect(reasons).toContain("latest_user_ask_not_foregrounded");
    expect(wrapQualityFeedback(reasons)).toContain(reasons.join(", "));
  });

  it("keeps everything except the named identifiers inside the 600-char reserve", () => {
    const reasons = auditWorstCase(BUDGET_FILLING_IDENTIFIERS);
    const feedback = qualityFeedback(reasons);
    const named = namedMissingIdentifiers(reasons).join(",");

    expect(named).toBe(BUDGET_FILLING_IDENTIFIERS[0]);
    expect(reasons).toContain("missing_identifiers_omitted:11");
    expect(feedback.length - named.length).toBeLessThanOrEqual(600);
    expect(wrapQualityFeedback(reasons)).toContain(feedback);
  });

  it("names all twelve short identifiers with no omission (anchor control)", () => {
    const reasons = auditWorstCase(SHORT_IDENTIFIERS);
    expect(namedMissingIdentifiers(reasons)).toStrictEqual(SHORT_IDENTIFIERS);
    expect(reasons.some((reason) => reason.startsWith("missing_identifiers_omitted:"))).toBe(false);
  });

  it("keeps the 4000-char cap for operator-supplied context (anchor control)", () => {
    const overCapText = "y".repeat(4200);
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", overCapText),
    ).not.toContain(overCapText);
  });

  it("skips an oversized identifier without hiding later complete values", () => {
    const identifiers = [
      `https://example.com/${"x".repeat(4000)}`,
      ...SHORT_IDENTIFIERS.slice(0, 11),
    ];
    const reasons = auditWorstCase(identifiers);
    expect(namedMissingIdentifiers(reasons)).toStrictEqual(identifiers.slice(1));
    expect(reasons).toContain("missing_identifiers_omitted:1");
  });
});
