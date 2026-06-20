import { describe, expect, it } from "vitest";
import {
  applyJudgeVerdictFinalOutputGuard,
  buildJudgeHandoffPreflight,
  parseJudgeCompletionVerdict,
} from "./judge-gate.js";

describe("Judge final output guard", () => {
  it("rewrites completion claims when Judge rejected the gate", () => {
    const guarded = applyJudgeVerdictFinalOutputGuard({
      payloads: [{ text: "Done. This is complete and verified." }],
      internalEvents: [
        {
          judgeVerdict: {
            status: "parsed",
            verdict: "REJECT",
            scope: "build completion",
            evidence: "direct command output: pnpm build exited 1",
            risk: "low",
            reason: "failed command evidence contradicts completion claim",
            conditions: "rerun build successfully",
          },
        },
      ],
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.audit).toMatchObject({
      action: "rewrote_final_success_claim",
      verdictStatus: "parsed",
      verdict: "REJECT",
      scope: "build completion",
      risk: "low",
      conditions: "rerun build successfully",
      payloadsChecked: 1,
      payloadsRewritten: 1,
    });
    expect(guarded.payloads[0]?.text).toContain("Judge did not approve this yet.");
    expect(guarded.payloads[0]?.text).toContain("VERDICT: REJECT");
    expect(guarded.payloads[0]?.text).toContain("CONDITIONS: rerun build successfully");
  });

  it("rewrites success claims when Judge output was malformed", () => {
    const guarded = applyJudgeVerdictFinalOutputGuard({
      payloads: [{ text: "Approved and ready." }],
      internalEvents: [
        {
          judgeVerdict: {
            status: "invalid",
            errors: ["expected 6 non-empty lines, got 1"],
          },
        },
      ],
    });

    expect(guarded.changed).toBe(true);
    expect(guarded.payloads[0]?.text).toContain("VERDICT: INVALID");
    expect(guarded.payloads[0]?.text).toContain("obtain a valid six-line Judge verdict");
  });

  it("leaves already blocked wording alone", () => {
    const guarded = applyJudgeVerdictFinalOutputGuard({
      payloads: [{ text: "Not approved yet. Judge rejected the completion claim." }],
      internalEvents: [
        {
          judgeVerdict: {
            status: "parsed",
            verdict: "REQUEST_MORE_EVIDENCE",
            scope: "release proof",
            evidence: "insufficient",
            risk: "medium",
            reason: "fresh evidence was missing",
            conditions: "provide current source proof",
          },
        },
      ],
    });

    expect(guarded.changed).toBe(false);
    expect(guarded.payloads[0]?.text).toBe(
      "Not approved yet. Judge rejected the completion claim.",
    );
  });

  it("does not rewrite approved Judge verdicts", () => {
    const guarded = applyJudgeVerdictFinalOutputGuard({
      payloads: [{ text: "Complete and verified." }],
      internalEvents: [
        {
          judgeVerdict: {
            status: "parsed",
            verdict: "APPROVE",
            scope: "docs-only update",
            evidence: "direct command output: docs check passed",
            risk: "low",
            reason: "scoped and evidenced",
            conditions: "none",
          },
        },
      ],
    });

    expect(guarded.changed).toBe(false);
    expect(guarded.payloads[0]?.text).toBe("Complete and verified.");
  });

  it("covers Todd-to-Judge-to-final-reply non-approval flow", () => {
    const handoff = buildJudgeHandoffPreflight({
      requestedAgentId: "judge",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      task: [
        'gate="completion_declaration";',
        'claim_or_action="Build passed and completion is approved";',
        'scope="release readiness";',
        'evidence="direct command output: pnpm build exited 1 and failed";',
        'instructions="completion claims require direct successful command evidence";',
        'risk="low";',
        'requested_verdict="approve";',
      ].join(" "),
    });
    expect(handoff.status).toBe("ready");
    if (handoff.status !== "ready") {
      throw new Error("expected ready Judge handoff");
    }
    expect(handoff.task).toContain("Deterministic Judge handoff preflight");
    expect(handoff.verdict.verdict).toBe("REJECT");

    const judgeCompletion = parseJudgeCompletionVerdict(
      [
        "VERDICT: REJECT",
        "SCOPE: release readiness",
        "EVIDENCE: direct command output: pnpm build exited 1 and failed",
        "RISK: low",
        "REASON: failed command evidence contradicts the completion claim",
        "CONDITIONS: rerun build successfully",
      ].join("\n"),
    );
    expect(judgeCompletion.status).toBe("parsed");

    const final = applyJudgeVerdictFinalOutputGuard({
      payloads: [{ text: "Done. The build is complete and verified." }],
      internalEvents: [
        {
          judgeVerdict: judgeCompletion,
        },
      ],
    });

    expect(final.changed).toBe(true);
    expect(final.payloads[0]?.text).toContain("Judge did not approve this yet.");
    expect(final.payloads[0]?.text).toContain("VERDICT: REJECT");
    expect(final.payloads[0]?.text).toContain("CONDITIONS: rerun build successfully");
  });
});
