import { beforeEach, describe, expect, it } from "vitest";
import { markSubagentCompletionDedupeDelivered } from "./subagent-registry-completion-dedupe.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function runRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-wave3",
    childSessionKey: "agent:main:subagent:wave3",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "verify wave3 completion evidence",
    cleanup: "keep",
    createdAt: 1_000,
    ...overrides,
  };
}

describe("subagent completion dedupe restart evidence", () => {
  beforeEach(() => {
    subagentRuns.clear();
  });

  it("preserves raw artifact reference, normalized result, and evidence verifier decision separately", () => {
    const entry = runRecord();
    subagentRuns.set(entry.runId, entry);

    markSubagentCompletionDedupeDelivered({
      childRunId: entry.runId,
      childSessionKey: entry.childSessionKey,
      dedupeKey: "active=current|childRun=run-wave3|result=abc",
      activeTaskContractId: "current",
      childSessionId: "session-wave3",
      taskId: "current-task",
      resultHash: "a".repeat(64),
      rawArtifactReference: {
        artifactId: "q_raw_wave3",
        sha256: "b".repeat(64),
        sizeBytes: 42,
      },
      normalizedResult: {
        normalizedState: "UNVERIFIED",
        contractVerdict: "EVIDENCE_UNVERIFIED",
        acceptanceEligible: false,
        classificationLabels: ["SCHEMA_VALID", "EVIDENCE_UNVERIFIED"],
        reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
      },
      evidenceVerifierDecision: {
        decision: "EVIDENCE_UNVERIFIED",
        acceptanceEligible: false,
        parentObserved: false,
        reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
      },
      now: 2_000,
    });

    expect(entry.completionDedupe?.lastRawArtifactReference).toEqual({
      artifactId: "q_raw_wave3",
      sha256: "b".repeat(64),
      sizeBytes: 42,
    });
    expect(entry.completionDedupe?.lastNormalizedResult).toMatchObject({
      normalizedState: "UNVERIFIED",
      contractVerdict: "EVIDENCE_UNVERIFIED",
      acceptanceEligible: false,
    });
    expect(entry.completionDedupe?.lastEvidenceVerifierDecision).toMatchObject({
      decision: "EVIDENCE_UNVERIFIED",
      parentObserved: false,
    });
    expect(entry.completionDedupe?.lastRawArtifactReference).not.toBe(
      entry.completionDedupe?.lastNormalizedResult,
    );
  });
});
