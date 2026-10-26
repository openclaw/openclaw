import { describe, expect, it } from "vitest";
import {
  auditSummaryQuality,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";

const LATEST_ASK = "report the deployment status";
const MISSING_IDENTIFIERS_PREFIX = "missing_identifiers:";
/**
 * Twelve 700-char URLs: joined (8,411 chars) they run well past the 4000-char untrusted
 * wrapper, so the worst case is genuinely exercised.
 */
const IDENTIFIER_CHARS = 700;
/** Unique per identifier, so a rendered head proves that value reached the prompt. */
function identifierHead(index: number): string {
  return `https://example.com/paths/segment-${String(index).padStart(2, "0")}/`;
}
const LONG_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) =>
    `${identifierHead(index)}${"x".repeat(IDENTIFIER_CHARS - identifierHead(index).length)}`,
);
const SHORT_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) => `abc${String(index).padStart(2, "0")}def12345`,
);
/** One value that fills the 3,400-char identifier budget exactly, then eleven that cannot fit. */
const BUDGET_FILLING_IDENTIFIERS = [
  `https://example.com/fill/${"f".repeat(3400 - "https://example.com/fill/".length)}`,
  ...Array.from({ length: 11 }, (_, index) => `id-${String(index).padStart(2, "0")}`),
];
/** The reserve compaction-safeguard-quality.ts keeps outside the identifier budget. */
const NON_IDENTIFIER_RESERVE_CHARS = 600;
const REQUIRED_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
];
const OVER_OPERATOR_CAP_TEXT = "y".repeat(4200);

/** Reproduces the safeguard's own feedback composition (compaction-safeguard.ts). */
function wrapQualityFeedback(reasons: string[]): string {
  return wrapUntrustedInstructionBlock(
    "Quality check feedback",
    `Previous summary failed quality checks (${reasons.join(", ")}).`,
  );
}

function namedMissingIdentifiers(reasons: string[]): string[] {
  const listed = reasons.find((reason) => reason.startsWith(MISSING_IDENTIFIERS_PREFIX));
  return listed ? listed.slice(MISSING_IDENTIFIERS_PREFIX.length).split(",") : [];
}

/**
 * Drives every audit reason that can co-occur, so the reason budget is measured at its true
 * maximum. latest_user_ask_not_foregrounded and latest_user_ask_not_reflected are exclusive;
 * an unresolved request drives the longer one.
 */
function auditWorstCase(identifiers: string[]): { ok: boolean; reasons: string[] } {
  return auditSummaryQuality({
    summary: "Nothing preserved.",
    structuralSummary: "Nothing preserved.",
    sourceSummaries: [REQUIRED_HEADINGS.flatMap((heading) => [heading, heading]).join("\n")],
    identifiers,
    latestAsk: LATEST_ASK,
    latestUnresolvedUserRequest: LATEST_ASK,
    retainedTurnSummary: `## Pending user asks\n${LATEST_ASK}`,
  });
}

describe("compaction-safeguard corrective quality feedback", () => {
  it("names only whole identifiers and counts the rest at the largest accepted input", () => {
    const { reasons } = auditWorstCase(LONG_IDENTIFIERS);

    const named = namedMissingIdentifiers(reasons);
    for (const value of named) {
      expect(LONG_IDENTIFIERS).toContain(value);
    }
    expect(named).toHaveLength(4);
    expect(reasons).toContain("missing_identifiers_omitted:8");
    // Every audited identifier is accounted for: named whole, or counted as omitted.
    expect(named.length + 8).toBe(LONG_IDENTIFIERS.length);
  });

  it("keeps the whole worst-case defect list inside the untrusted feedback block", () => {
    const { reasons } = auditWorstCase(LONG_IDENTIFIERS);

    // Every reason code that can co-occur fires here, so this is the maximum text the
    // corrective pass can carry. If the wrapper cap ever cuts it, an identifier is delivered
    // half-written.
    expect(reasons.length).toBeGreaterThanOrEqual(13);
    expect(reasons).toContain("latest_user_ask_not_foregrounded");
    expect(wrapQualityFeedback(reasons)).toContain(reasons.join(", "));
  });

  it("keeps everything except the named identifiers inside the 600-char reserve", () => {
    const { reasons } = auditWorstCase(BUDGET_FILLING_IDENTIFIERS);
    const feedback = `Previous summary failed quality checks (${reasons.join(", ")}).`;
    const named = namedMissingIdentifiers(reasons).join(",");

    // The first value fills the identifier budget exactly, so nothing after it fits.
    expect(named).toBe(BUDGET_FILLING_IDENTIFIERS[0]);
    expect(reasons).toContain("missing_identifiers_omitted:11");
    // This overhead is what the reserve in compaction-safeguard-quality.ts must cover.
    expect(feedback.length - named.length).toBeLessThanOrEqual(NON_IDENTIFIER_RESERVE_CHARS);
    expect(wrapQualityFeedback(reasons)).toContain(feedback);
  });

  it("names all twelve short identifiers with no omission (anchor control)", () => {
    const { reasons } = auditWorstCase(SHORT_IDENTIFIERS);

    expect(namedMissingIdentifiers(reasons)).toStrictEqual(SHORT_IDENTIFIERS);
    expect(reasons.some((reason) => reason.startsWith("missing_identifiers_omitted:"))).toBe(false);
  });

  it("keeps the 4000-char cap for operator-supplied context (anchor control)", () => {
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", OVER_OPERATOR_CAP_TEXT),
    ).not.toContain(OVER_OPERATOR_CAP_TEXT);
  });

  it("skips an oversized identifier without hiding later complete values", () => {
    const identifiers = [
      `https://example.com/${"x".repeat(4000)}`,
      ...SHORT_IDENTIFIERS.slice(0, 11),
    ];
    const { reasons } = auditWorstCase(identifiers);
    expect(namedMissingIdentifiers(reasons)).toStrictEqual(identifiers.slice(1));
    expect(reasons).toContain("missing_identifiers_omitted:1");
  });
});
