import { describe, expect, it } from "vitest";
import { auditSummaryQuality } from "./compaction-safeguard-quality.js";

const structuredSummary = (pendingAsk: string, decision = "Keep current flow.") =>
  [
    `## Decisions\n${decision}`,
    "## Open TODOs\nNone.",
    "## Constraints/Rules\nPreserve the request state.",
    `## Pending user asks\n${pendingAsk}`,
    "## Exact identifiers\nNone.",
  ].join("\n");

describe("compaction summary request matching", () => {
  it("scopes retained ask checks to the split prefix without matching shared numbers", () => {
    const latestAsk = "Compare 10 and 20";
    const prefixSummary = (pendingAsk?: string) =>
      [
        `## Original Request\n${latestAsk}`,
        "## Early Progress\nValidated the provider boxes.",
        "## Context for Suffix\nThe retained suffix owns continuation state.",
        ...(pendingAsk ? [`## Pending user asks\n${pendingAsk}`] : []),
      ].join("\n");
    const decision = `${latestAsk} after validation.`;
    const historySummary = structuredSummary(latestAsk, decision);
    const structuralSummary = structuredSummary(
      `Latest user request context: ${JSON.stringify(latestAsk)}`,
      decision,
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

    expect(auditRetained(prefixSummary())).toEqual({ ok: true, reasons: [] });
    expect(auditRetained(prefixSummary("Wait 10 to 20 seconds for deployment"))).toEqual({
      ok: true,
      reasons: [],
    });
    expect(auditRetained(historySummary).reasons).toContain("retained_turn_ask_marked_pending");
    expect(auditRetained(prefixSummary(latestAsk)).reasons).toContain(
      "retained_turn_ask_marked_pending",
    );
  });

  it.each(["请提供状态更新", "How about now?"])("flags an omitted latest ask: %s", (latestAsk) => {
    const summary = structuredSummary("No pending asks.");
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
