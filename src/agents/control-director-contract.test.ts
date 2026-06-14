import { describe, expect, it } from "vitest";
import {
  applyControlDirectorFinalOutputGuard,
  applyControlDirectorJudgeCompletionGate,
  applyControlDirectorLivenessWatchdog,
  buildControlDirectorJudgeClaimHash,
  buildControlDirectorSystemPromptSection,
  decideControlDirectorContinuation,
  evaluateControlDirectorResponse,
  resolveControlDirectorThinkingEscalation,
  scoreControlDirectorReadiness,
  summarizeControlDirectorMissionFinalText,
} from "./control-director-contract.ts";

describe("Control Director contract", () => {
  it("injects the operating contract only for the Control Director", () => {
    const section = buildControlDirectorSystemPromptSection("main").join("\n");
    expect(section).toContain("Control Director Operating Contract");
    expect(section).toContain("numeric `/10` values");
    expect(section).toContain("exact response format");
    expect(section).toContain("requires Judge approval");
    expect(buildControlDirectorSystemPromptSection("builder")).toEqual([]);
  });

  it("requires evidence for every complete status even when evidence was not requested separately", () => {
    const result = evaluateControlDirectorResponse({
      text: [
        "Completion Grade: 10/10",
        "Criticality: 8/10",
        "Next build gap: none detected.",
        "Status: complete",
      ].join("\n"),
      requirements: {
        completionState: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe("complete");
    expect(result.missing).toContain("verified evidence for complete status");
  });

  it("allows non-complete status reports to omit evidence when evidence is not required", () => {
    const result = evaluateControlDirectorResponse({
      text: [
        "Completion Grade: 8/10",
        "Criticality: 8/10",
        "Next build gap: user must approve the external action.",
        "Status: needs_user_input",
      ].join("\n"),
      requirements: {
        completionState: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result).toEqual({ passed: true, status: "needs_user_input", missing: [] });
  });

  it("accepts live blocked reports with an explicit status line", () => {
    const result = evaluateControlDirectorResponse({
      text: [
        "Completion Grade: 0/10",
        "Criticality: 1/10 (smoke test)",
        "Verified state: No verification performed — no evidence exists",
        "Next build gap: Verification commands or evidence sources required",
        "Status: blocked",
      ].join("\n"),
      requirements: {
        completionState: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result).toEqual({ passed: true, status: "blocked", missing: [] });
  });

  it("does not treat implicit completion wording as the required explicit status", () => {
    const result = evaluateControlDirectorResponse({
      text: [
        "Completion Grade: 10/10",
        "Criticality: 8/10",
        "Verified evidence: pnpm build passed and the Qwen smoke returned status 200.",
        "Next build gap: no critical gap detected.",
        "Done.",
      ].join("\n"),
      requirements: {
        completionState: true,
        completionGrade: true,
        criticality: true,
        nextBuildGap: true,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe("complete");
    expect(result.missing).toEqual(["explicit completion status"]);
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

  it("rewrites unsupported Control Director complete claims before delivery", () => {
    const guarded = applyControlDirectorFinalOutputGuard({
      agentId: "main",
      payloads: [
        {
          text: [
            "Completion Grade: 10/10",
            "Criticality: 10/10",
            "Next build gap: none.",
            "Status: complete",
          ].join("\n"),
        },
      ],
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "rewrote_unsupported_complete",
      originalStatus: "complete",
      nextStatus: "blocked",
      payloadsChecked: 1,
      payloadsRewritten: 1,
    });
    expect(guarded.payloads[0]?.text).toContain("completion guard blocked");
    expect(guarded.payloads[0]?.text).toContain("Verified state:");
    expect(guarded.payloads[0]?.text).toContain("Status: blocked");
  });

  it("leaves verified Control Director complete reports unchanged", () => {
    const text = [
      "Completion Grade: 10/10",
      "Criticality: 10/10",
      "Verified evidence: pnpm build passed and smoke returned status=200.",
      "Next build gap: No critical Control Director gap detected.",
      "Status: complete",
    ].join("\n");
    const guarded = applyControlDirectorFinalOutputGuard({
      agentId: "main",
      payloads: [{ text }],
    });

    expect(guarded).toEqual({ payloads: [{ text }], changed: false });
  });

  it("blocks Control Director complete reports without Judge approval", () => {
    const text = [
      "Completion Grade: 10/10",
      "Criticality: 10/10",
      "Verified evidence: pnpm build passed and smoke returned status=200.",
      "Next build gap: No critical Control Director gap detected.",
      "Status: complete",
    ].join("\n");

    const guarded = applyControlDirectorJudgeCompletionGate({
      agentId: "main",
      payloads: [{ text }],
      missionId: "control-director:run-judge-required",
      requestBody: "Ship it.",
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "blocked_missing_judge_approval",
      originalStatus: "complete",
      nextStatus: "blocked",
      missing: ["Judge approval metadata"],
      payloadsChecked: 1,
      payloadsRewritten: 1,
    });
    expect(guarded.payloads[0]?.text).toContain("Judge completion gate blocked");
    expect(guarded.payloads[0]?.text).toContain("Verified state: completion was not delivered");
    expect(guarded.payloads[0]?.text).toContain("Status: blocked");
  });

  it("allows Control Director complete reports with matching Judge approval", () => {
    const missionId = "control-director:run-judge-approved";
    const requestBody = "Complete the implementation.";
    const text = [
      "Completion Grade: 10/10",
      "Criticality: 10/10",
      "Verified evidence: pnpm check:changed passed and remote proof passed.",
      "Next build gap: none.",
      "Status: complete",
    ].join("\n");
    const evidenceSummary = summarizeControlDirectorMissionFinalText(text).verifiedEvidenceSummary;
    const approvedClaimHash = buildControlDirectorJudgeClaimHash({
      missionId,
      requestBody,
      finalText: text,
      evidenceSummary,
    });

    const guarded = applyControlDirectorJudgeCompletionGate({
      agentId: "main",
      payloads: [{ text }],
      missionId,
      requestBody,
      approval: {
        judgeStatus: "approved",
        judgeVerdict: "APPROVE",
        judgeRunId: "judge-run-1",
        missionId,
        approvedClaimHash,
        evidenceSummary,
        scope: "Control Director completion for run-judge-approved",
        approvedAt: 123,
      },
    });

    expect(guarded).toEqual({
      payloads: [{ text }],
      changed: false,
      expectedClaimHash: approvedClaimHash,
      approval: expect.objectContaining({
        judgeStatus: "approved",
        judgeVerdict: "APPROVE",
        judgeRunId: "judge-run-1",
      }),
    });
  });

  it("blocks stale, rejected, or incomplete Judge approvals", () => {
    const text = [
      "Completion Grade: 10/10",
      "Criticality: 10/10",
      "Verified evidence: local proof passed.",
      "Next build gap: none.",
      "Status: complete",
    ].join("\n");

    const guarded = applyControlDirectorJudgeCompletionGate({
      agentId: "main",
      payloads: [{ text }],
      missionId: "control-director:current",
      requestBody: "Finish this.",
      approval: {
        judgeStatus: "rejected",
        judgeVerdict: "REQUEST_MORE_EVIDENCE",
        judgeRunId: "judge-run-old",
        missionId: "control-director:previous",
        approvedClaimHash: "stale",
        evidenceSummary: "",
        scope: "",
        approvedAt: 0,
        missingAcceptanceCriteria: ["remote proof"],
      },
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "blocked_invalid_judge_approval",
      originalStatus: "complete",
      nextStatus: "blocked",
    });
    expect(guarded.audit?.missing).toEqual(
      expect.arrayContaining([
        "Judge status approved (actual: rejected)",
        "Judge verdict APPROVE (actual: REQUEST_MORE_EVIDENCE)",
        "matching mission id",
        "matching approved claim hash",
        "Judge evidence summary",
        "Judge approval scope",
        "Judge approval timestamp",
        "zero missing acceptance criteria (remote proof)",
      ]),
    );
  });

  it("does not require Judge approval for non-Control-Director agents or blocked reports", () => {
    const completePayloads = [{ text: "Status: complete" }];
    expect(
      applyControlDirectorJudgeCompletionGate({
        agentId: "builder",
        payloads: completePayloads,
        missionId: "builder:run",
        requestBody: "done",
      }),
    ).toEqual({ payloads: completePayloads, changed: false });

    const blockedPayloads = [{ text: "Verified state: blocked.\nStatus: blocked" }];
    expect(
      applyControlDirectorJudgeCompletionGate({
        agentId: "main",
        payloads: blockedPayloads,
        missionId: "control-director:blocked",
        requestBody: "done",
      }),
    ).toEqual({ payloads: blockedPayloads, changed: false, approval: undefined });
  });

  it("repairs missing Control Director report fields without changing truthful blocked status", () => {
    const guarded = applyControlDirectorFinalOutputGuard({
      agentId: "main",
      payloads: [
        {
          text: "Status: blocked\nWaiting for user approval before running external validation.",
        },
      ],
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "repaired_missing_required_fields",
      originalStatus: "blocked",
      nextStatus: "blocked",
    });
    expect(guarded.payloads[0]?.text).toContain("Verified state:");
    expect(guarded.payloads[0]?.text).toContain("Completion Grade: 8/10");
    expect(guarded.payloads[0]?.text).toContain("Criticality: 10/10");
    expect(guarded.payloads[0]?.text).toContain("Status: blocked");
  });

  it("allows complete field repair when evidence already supports the completion claim", () => {
    const guarded = applyControlDirectorFinalOutputGuard({
      agentId: "main",
      payloads: [
        {
          text: "Verified evidence: smoke output passed and tests passed. Done.",
        },
      ],
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "repaired_missing_required_fields",
      originalStatus: "complete",
      nextStatus: "complete",
    });
    expect(guarded.payloads[0]?.text).toContain("Status: complete");
  });

  it("does not apply the final-output guard to non-Control-Director agents", () => {
    const payloads = [{ text: "Done." }];
    const guarded = applyControlDirectorFinalOutputGuard({
      agentId: "builder",
      payloads,
    });

    expect(guarded).toEqual({ payloads, changed: false });
  });

  it("turns empty Control Director output into a visible blocked continuation report", () => {
    const guarded = applyControlDirectorLivenessWatchdog({
      agentId: "main",
      payloads: [],
      classification: "empty",
      continuationCount: 0,
      missionId: "mission-1",
      canQueueContinuation: true,
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.continuation).toMatchObject({
      status: "queue",
      shouldQueue: true,
      nextContinuationCount: 1,
    });
    expect(guarded.audit).toMatchObject({
      action: "queued_safe_continuation",
      classification: "empty",
      continuationQueued: true,
      payloadsChecked: 0,
      payloadsSynthesized: 1,
    });
    const payload = guarded.payloads[0] as { text: string } | undefined;
    expect(payload?.text).toContain("Verified state:");
    expect(payload?.text).toContain("Safe continuation queued: yes");
    expect(payload?.text).toContain("Status: blocked");
  });

  it("blocks Control Director continuation after the safe retry limit", () => {
    const decision = decideControlDirectorContinuation({
      agentId: "main",
      incomplete: true,
      classification: "planning-only",
      continuationCount: 2,
      canQueueContinuation: true,
    });

    expect(decision).toMatchObject({
      status: "blocked",
      shouldQueue: false,
      reason: "safe continuation limit reached",
      continuationCount: 2,
      nextContinuationCount: 3,
    });
  });

  it("does not queue continuation when user input is required", () => {
    const decision = decideControlDirectorContinuation({
      agentId: "main",
      incomplete: true,
      finalStatus: "needs_user_input",
      continuationCount: 0,
      canQueueContinuation: true,
    });

    expect(decision).toMatchObject({
      status: "blocked",
      shouldQueue: false,
      reason: "user input is required before safe continuation",
    });
  });

  it("summarizes Control Director mission evidence for the ledger", () => {
    const summary = summarizeControlDirectorMissionFinalText(
      [
        "Verified evidence: pnpm test passed.",
        "Next build gap: remote proof still required.",
        "Completion Grade: 9.2/10",
        "Criticality: 10/10",
        "Status: blocked",
      ].join("\n"),
    );

    expect(summary).toEqual({
      finalStatus: "blocked",
      status: "blocked",
      verifiedEvidenceSummary: "pnpm test passed.",
      nextBuildGap: "remote proof still required.",
      completionGrade: 9.2,
      criticality: 10,
    });
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
      expect.arrayContaining([
        "verified evidence for complete status",
        "Completion Grade /10",
        "Criticality /10",
      ]),
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
