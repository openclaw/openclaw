import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  testing,
  structuredSummary,
  headingTemplate,
} from "./compaction-safeguard.test-support.js";

const {
  capCompactionSummary,
  budgetCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
} = testing;
const requireRecord = createRequireRecord("object", "expected-record");

function budgetCompactionSummaryText(
  body: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  return (
    budgetCompactionSummary(body, { text: suffix, contextRanges: [] }, maxChars) as {
      summary: string;
    }
  ).summary;
}

describe("compaction-safeguard summary budgets", () => {
  it("preserves diagnostic sections (tool failures, file ops) when capping oversized body", () => {
    const diagnosticSuffix =
      "\n\n## Tool Failures\n- exec: failed\n\n<read-files>\nfoo.ts\n</read-files>\n\n" +
      "<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const body = "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);

    const capped = budgetCompactionSummaryText(body, diagnosticSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped.endsWith(diagnosticSuffix)).toBe(true);
  });

  it("uses truncation markers when the budget exactly fits only the marker", () => {
    expect(capCompactionSummary("oversized".repeat(10), SUMMARY_TRUNCATED_MARKER.length)).toBe(
      SUMMARY_TRUNCATED_MARKER,
    );
    expect(
      budgetCompactionSummaryText(
        "",
        "oversized suffix".repeat(10),
        CONTEXT_TRUNCATED_MARKER.length,
      ),
    ).toBe(CONTEXT_TRUNCATED_MARKER);
  });

  it("preserves exact identifiers when recompacting encoded heading-like context", () => {
    const latestAsk = headingTemplate("zephyr quasar template must survive:");
    const identifier = "REAL-OLD-ID-MUST-SURVIVE";
    const body = structuredSummary({ decisions: "No related decision.", identifiers: identifier });
    const first = requireRecord(
      budgetCompactionSummary(body, { text: "", contextRanges: [] }, 1_000, {
        identifiers: [identifier],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );
    expect(String(first.summary)).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );

    const second = requireRecord(
      budgetCompactionSummary(String(first.summary), { text: "", contextRanges: [] }, 700, {
        identifiers: [identifier],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );

    expect(String(second.summary)).toContain(identifier);
    expect(String(second.summary)).toContain(
      `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
    );
  });
});
