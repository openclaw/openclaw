import { describe, expect, it, vi } from "vitest";
import type { JudgmentOutcome } from "../../judgments/types.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  isCompactionSemanticRepairFinding,
  observeCompactionSemanticFidelity,
  prepareCompactionSemanticFidelityEvidence,
} from "./compaction-semantic-fidelity.js";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

describe("compaction semantic fidelity", () => {
  it("skips user content already preserved verbatim", () => {
    const evidence = prepareCompactionSemanticFidelityEvidence({
      sourceMessages: [user("Keep production untouched."), user("Deploy staging.")],
      retainedContext: "Deploy staging.",
    });

    expect(evidence.coverage.verbatimPreserved).toBe(1);
    expect(evidence.sourceItems).toHaveLength(1);
    expect(evidence.sourceItems[0]?.text).toBe("Keep production untouched.");
  });

  it("returns no-candidates without calling the judgment runtime", async () => {
    const evaluate = vi.fn();
    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Deploy staging.")],
        retainedContext: "Deploy staging.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.status).toBe("no-candidates");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("preserves choice distributions and provenance", async () => {
    const outcome: JudgmentOutcome = {
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "recent-user-1": {
            type: "choice",
            choice: "contradicted",
            probabilities: {
              preserved: 0.01,
              missing: 0.03,
              contradicted: 0.9,
              inactive_or_completed: 0.01,
              uncertain: 0.05,
            },
            confidence: 0.88,
          },
        },
        usage: { inputTokens: 42, outputTokens: 0 },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "generation",
      },
    };
    const evaluate = vi.fn(async () => outcome);

    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Use staging only. Production is not authorized.")],
        retainedContext: "Deploy to production.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result).toMatchObject({
      status: "ok",
      providerId: "fixture",
      model: "fixture",
      findings: [
        {
          relation: "contradicted",
          sourceText: "Use staging only. Production is not authorized.",
          sourceTruncated: false,
          confidence: 0.88,
          probabilities: { contradicted: 0.9 },
        },
      ],
    });
  });


  it("only qualifies strong missing or contradicted findings with complete source evidence", () => {
    expect(
      isCompactionSemanticRepairFinding({
        id: "one",
        relation: "missing",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { missing: 0.84 },
      }),
    ).toBe(true);
    expect(
      isCompactionSemanticRepairFinding({
        id: "two",
        relation: "contradicted",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { contradicted: 0.79 },
      }),
    ).toBe(false);
    expect(
      isCompactionSemanticRepairFinding({
        id: "three",
        relation: "missing",
        sourceText: "Keep production untouched.",
        sourceTruncated: true,
        probabilities: { missing: 0.99 },
      }),
    ).toBe(false);
    expect(
      isCompactionSemanticRepairFinding({
        id: "four",
        relation: "uncertain",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { uncertain: 0.99 },
      }),
    ).toBe(false);
  });

  it("returns provider unavailability without inventing a semantic result", async () => {
    const evaluate = vi.fn(async () => ({
      status: "unavailable",
      reason: "circuit-open",
    }) satisfies JudgmentOutcome);

    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Keep production untouched.")],
        retainedContext: "Deployment notes.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "circuit-open",
      checked: 1,
    });
  });
});
