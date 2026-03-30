import { describe, expect, it } from "vitest";
import {
  isLikelyTrivialChiefReply,
  parseQualityGuardReview,
  shouldRequireChiefQualityGuardReview,
} from "./quality-guard.js";

describe("quality guard heuristics", () => {
  it("treats short receipt replies as trivial", () => {
    expect(
      isLikelyTrivialChiefReply({
        originalPrompt: "ping",
        replyText: "Got it. I am on it.",
      }),
    ).toBe(true);
  });

  it("requires review for structured substantial replies", () => {
    expect(
      shouldRequireChiefQualityGuardReview({
        agentId: "chief",
        originalPrompt: "Review this deployment plan and finalize it.",
        replyText: [
          "**Plan**",
          "",
          "1. Validate the rollout path.",
          "2. Run the release checks.",
          "3. Finalize the deployment summary.",
        ].join("\n"),
      }),
    ).toBe(true);
  });

  it("bypasses review for non-chief agents", () => {
    expect(
      shouldRequireChiefQualityGuardReview({
        agentId: "engineering_lead",
        originalPrompt: "Implement this change.",
        replyText: "Here is the implementation plan.",
      }),
    ).toBe(false);
  });
});

describe("quality guard contract parsing", () => {
  it("parses valid JSON contracts", () => {
    const parsed = parseQualityGuardReview(`{
      "verdict": "approve",
      "severity": "low",
      "findings": [],
      "missing_evidence": [],
      "scope_or_logic_issues": [],
      "required_revisions": [],
      "paperclip_update_safe": true,
      "can_finalize": true
    }`);
    expect(parsed.verdict).toBe("approve");
    expect(parsed.can_finalize).toBe(true);
  });

  it("blocks malformed contracts", () => {
    const parsed = parseQualityGuardReview("not-json");
    expect(parsed.verdict).toBe("block");
    expect(parsed.can_finalize).toBe(false);
    expect(parsed.findings[0]).toContain("invalid review contract");
  });
});
