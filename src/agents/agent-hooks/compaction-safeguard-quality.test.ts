import { describe, expect, it } from "vitest";
import { auditSummaryQuality } from "./compaction-safeguard-quality.js";

describe("compaction summary request matching", () => {
  it.each(["combine the provider boxes into one artifact", "Compare 10 and 20"])(
    "scopes retained ask checks to the split-prefix summary for %s",
    (latestAsk) => {
      const structuredSummary = (pendingAsk: string) =>
        [
          "## Decisions",
          `${latestAsk} after validation.`,
          "## Open TODOs",
          "None.",
          "## Constraints/Rules",
          "Preserve the request state.",
          "## Pending user asks",
          pendingAsk,
          "## Exact identifiers",
          "None.",
        ].join("\n");
      const prefixSummary = (pendingAsk?: string) =>
        [
          "## Original Request",
          latestAsk,
          "## Early Progress",
          "Validated the provider boxes.",
          "## Context for Suffix",
          "The retained suffix owns continuation state.",
          ...(pendingAsk ? ["## Pending user asks", pendingAsk] : []),
        ].join("\n");
      const historySummary = structuredSummary(latestAsk);
      const structuralSummary = structuredSummary(
        `Latest user request context: ${JSON.stringify(latestAsk)}`,
      );
      const auditRetained = (retainedTurnSummary: string) =>
        auditSummaryQuality({
          summary: `${structuralSummary}\n\n${retainedTurnSummary}`,
          structuralSummary,
          sourceSummaries: [historySummary, retainedTurnSummary],
          identifiers: [],
          latestAsk,
          retainedTurnSummary,
        });

      expect(auditRetained(prefixSummary())).toEqual({
        ok: true,
        reasons: [],
      });
      expect(auditRetained(prefixSummary("Wait 10 to 20 seconds for deployment"))).toEqual({
        ok: true,
        reasons: [],
      });
      expect(auditRetained(historySummary).reasons).toContain("retained_turn_ask_marked_pending");
      expect(auditRetained(prefixSummary(latestAsk)).reasons).toContain(
        "retained_turn_ask_marked_pending",
      );
    },
  );

  it.each(["请提供状态更新", "How about now?"])("flags an omitted latest ask: %s", (latestAsk) => {
    const summary = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve safety checks.",
      "## Pending user asks",
      "No pending asks.",
      "## Exact identifiers",
      "None.",
    ].join("\n");
    const quality = auditSummaryQuality({
      summary,
      structuralSummary: summary,
      identifiers: [],
      latestAsk,
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_reflected");
  });
});
