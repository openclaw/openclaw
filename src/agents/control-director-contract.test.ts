import { describe, expect, it } from "vitest";
import {
  buildControlDirectorSystemPromptSection,
  evaluateControlDirectorResponse,
  resolveControlDirectorThinkingEscalation,
  scoreControlDirectorReadiness,
} from "./control-director-contract.ts";

describe("Control Director contract", () => {
  it("injects the operating contract only for the Control Director", () => {
    const section = buildControlDirectorSystemPromptSection("main").join("\n");
    expect(section).toContain("Control Director Operating Contract");
    expect(section).toContain("numeric `/10` values");
    expect(section).toContain("exact response format");
    expect(buildControlDirectorSystemPromptSection("builder")).toEqual([]);
  });

  it("requires explicit status, evidence, grade, criticality, and next build gap", () => {
    const result = evaluateControlDirectorResponse({
      text: [
        "Completion Grade: 9.5/10",
        "Criticality: 10/10",
        "Verified evidence: pnpm build passed and smoke output returned CONTROL_QWEN36_OK.",
        "Next build gap: no critical gap detected.",
        "Status: complete",
      ].join("\n"),
      requirements: {
        completionState: true,
        verifiedEvidence: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result).toEqual({ passed: true, status: "complete", missing: [] });
  });

  it("does not allow an unverifiable report to pass the production response contract", () => {
    const result = evaluateControlDirectorResponse({
      text: "Looks good. Next build gap: none. Status: complete",
      requirements: {
        completionState: true,
        verifiedEvidence: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(["verified evidence", "Completion Grade /10", "Criticality /10"]),
    );
  });

  it("weights critical readiness facts when scoring production readiness", () => {
    const scorecard = scoreControlDirectorReadiness([
      { id: "primary", label: "Primary model alias", passed: true, critical: true },
      { id: "fallback", label: "Fallback model", passed: true, critical: true },
      { id: "evals", label: "Deterministic eval suite", passed: false, critical: true },
      { id: "docs", label: "Documentation", passed: true, critical: false },
    ]);

    expect(scorecard.productionReady).toBe(false);
    expect(scorecard.failedCritical).toContain("Deterministic eval suite");
    expect(scorecard.nextBuildGap).toContain("Deterministic eval suite");
  });

  it("keeps routine Control Director turns non-thinking", () => {
    expect(
      resolveControlDirectorThinkingEscalation({
        agentId: "main",
        text: "Is thinking defaulted for the Control Director?",
      }),
    ).toMatchObject({ level: "off", escalated: false });
  });

  it("escalates Control Director implementation and evaluation work to medium", () => {
    expect(
      resolveControlDirectorThinkingEscalation({
        agentId: "main",
        text: "Implement the plan, verify it, and report the next build gap.",
      }),
    ).toMatchObject({ level: "medium", escalated: true });
  });

  it("escalates Control Director rollback, runtime, and model-risk work to high", () => {
    expect(
      resolveControlDirectorThinkingEscalation({
        agentId: "control-director",
        text: "Rollback the Ollama model routing after the production smoke test failed.",
      }),
    ).toMatchObject({ level: "high", escalated: true });
  });

  it("does not apply the thinking policy to other agents", () => {
    expect(
      resolveControlDirectorThinkingEscalation({
        agentId: "builder",
        text: "Implement the plan and verify the build.",
      }),
    ).toBeUndefined();
  });
});
