import { describe, expect, it } from "vitest";
import {
  auditSummaryQuality,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";

const LATEST_ASK = "report the deployment status";
// Twelve distinct 700-char URLs exceed the 4k wrapper; only four fit the 3,400-char budget.
const LONG_IDENTIFIERS = Array.from({ length: 12 }, (_, index) =>
  `https://example.com/paths/segment-${index}/`.padEnd(700, "x"),
);
const SHORT_IDENTIFIERS = Array.from({ length: 12 }, (_, index) => `id-${index}`);
const LATER_IDENTIFIERS = SHORT_IDENTIFIERS.slice(0, 11);
const BUDGET_FILLER = "https://example.com/fill/".padEnd(3400, "f");

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
  it.each<[string, string[], string[], number]>([
    ["long values", LONG_IDENTIFIERS, LONG_IDENTIFIERS.slice(0, 4), 8],
    ["exact budget fill", [BUDGET_FILLER, ...LATER_IDENTIFIERS], [BUDGET_FILLER], 11],
    ["short values", SHORT_IDENTIFIERS, SHORT_IDENTIFIERS, 0],
    ["oversized first value", ["x".repeat(4001), ...LATER_IDENTIFIERS], LATER_IDENTIFIERS, 1],
  ])(
    "preserves whole identifiers and bounded feedback: %s",
    (_name, identifiers, expected, omitted) => {
      const reasons = auditWorstCase(identifiers);
      const listed = reasons.find((reason) => reason.startsWith("missing_identifiers:"));
      expect(listed?.slice("missing_identifiers:".length).split(",") ?? []).toStrictEqual(expected);
      expect(reasons.filter((reason) => reason.startsWith("missing_identifiers_omitted:"))).toEqual(
        omitted ? [`missing_identifiers_omitted:${omitted}`] : [],
      );
      expect(reasons.length).toBeGreaterThanOrEqual(13);
      expect(reasons).toContain("latest_user_ask_not_foregrounded");
      const feedback = `Previous summary failed quality checks (${reasons.join(", ")}).`;
      expect(feedback.length - expected.join(",").length).toBeLessThanOrEqual(600);
      expect(wrapUntrustedInstructionBlock("Quality check feedback", feedback)).toContain(feedback);
    },
  );

  it("keeps the 4000-char cap for operator-supplied context (anchor control)", () => {
    const overCapText = "y".repeat(4200);
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", overCapText),
    ).not.toContain(overCapText);
  });
});
