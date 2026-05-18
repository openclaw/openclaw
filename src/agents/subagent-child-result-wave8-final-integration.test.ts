import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildParentVisibleChildResult,
  classifyChildResultContract,
  sha256Text,
  type ChildResultClassification,
  type ChildResultParentRuntimeEvidence,
} from "./subagent-child-result-contract.js";
import {
  renderChildResultDashboardStatus,
  resolveChildResultRolloutMode,
} from "./subagent-child-result-rollout.js";

let tmpRoot = "";

function tmpPath(name: string): string {
  return path.join(tmpRoot, name);
}

function writeFileArtifact(
  name: string,
  body: string,
): { path: string; sha256: string; sizeBytes: number } {
  const filePath = tmpPath(name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
  return {
    path: filePath,
    sha256: sha256Text(body),
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

function verifiedParams(options: {
  role: "parent_runtime" | "checker" | "mediator";
  childRunId: string;
  childSessionKey: string;
  artifactName?: string;
  logName?: string;
}): {
  rawText: string;
  expectedOutputArtifacts: Array<{ path: string; sha256: string; schema: string }>;
  parentScopeCheck: { allowedChangedPaths: string[]; allowedSourcePaths: string[] };
  scopedGateProcesses: Array<{ name: string; status: string }>;
  parentRuntimeEvidence: ChildResultParentRuntimeEvidence;
  childRunId: string;
  childSessionKey: string;
  spawnedAtMs: number;
  requireActiveTaskContract: false;
} {
  const artifact = writeFileArtifact(
    options.artifactName ?? `${options.role}-verdict.json`,
    `${JSON.stringify({ verdict: "PASS", role: options.role })}\n`,
  );
  const log = writeFileArtifact(
    options.logName ?? `${options.role}-focused.log`,
    `${options.role} focused gate passed\n`,
  );
  const observedAtMs = Date.now() + 2_000;
  const spawnedAtMs = observedAtMs - 5_000;
  const commandId = `cmd-${options.role}`;
  const scope = {
    allowedChangedPaths: ["src/agents/subagent-child-result-contract.ts"],
    allowedSourcePaths: ["src/agents/subagent-child-result-contract.ts"],
    allowedArtifactPaths: [artifact.path],
    allowedLogPaths: [log.path],
  };
  return {
    rawText: JSON.stringify({
      schemaVersion: 1,
      verdict: "PASS",
      outputArtifacts: [
        {
          artifactId: `artifact-${options.role}`,
          path: artifact.path,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        },
      ],
      changedPaths: ["src/agents/subagent-child-result-contract.ts"],
      sourcePaths: ["src/agents/subagent-child-result-contract.ts"],
      commandsRun: [{ commandId, status: "passed", exitCode: 0 }],
    }),
    expectedOutputArtifacts: [
      { path: artifact.path, sha256: artifact.sha256, schema: "child-result-report" },
    ],
    parentScopeCheck: {
      allowedChangedPaths: scope.allowedChangedPaths,
      allowedSourcePaths: scope.allowedSourcePaths,
    },
    scopedGateProcesses: [{ name: `${options.role} focused gate`, status: "passed" }],
    spawnedAtMs,
    childRunId: options.childRunId,
    childSessionKey: options.childSessionKey,
    requireActiveTaskContract: false,
    parentRuntimeEvidence: {
      observedBy: options.role,
      observedAtMs,
      childRunId: options.childRunId,
      childSessionKey: options.childSessionKey,
      scope,
      repoState: { commitId: "wave8", headCommitId: "wave8", worktreeDirty: false },
      artifacts: [
        {
          artifactId: `artifact-${options.role}`,
          path: artifact.path,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          observedAtMs,
          childRunId: options.childRunId,
          childSessionKey: options.childSessionKey,
        },
      ],
      commands: [
        {
          commandId,
          status: "passed",
          exitCode: 0,
          logId: `log-${options.role}`,
          logPath: log.path,
          logSha256: log.sha256,
          observedAtMs,
          childRunId: options.childRunId,
          childSessionKey: options.childSessionKey,
        },
      ],
      logs: [
        {
          logId: `log-${options.role}`,
          path: log.path,
          sha256: log.sha256,
          sizeBytes: log.sizeBytes,
          observedAtMs,
          childRunId: options.childRunId,
          childSessionKey: options.childSessionKey,
        },
      ],
      staleProcessSweep: {
        status: "passed",
        noRunningProcesses: true,
        logId: `stale-sweep-${options.role}`,
        logPath: log.path,
        logSha256: log.sha256,
        observedAtMs,
        childRunId: options.childRunId,
        childSessionKey: options.childSessionKey,
      },
    },
  };
}

function satisfiesAcceptanceGate(classification: ChildResultClassification): boolean {
  return (
    classification.normalizedState === "VERIFIED_PASS" &&
    classification.acceptanceEligible &&
    classification.evidenceVerifier?.decision === "VERIFIED_PASS"
  );
}

describe("malformed subagent output Wave 8 final integration", () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wave8-final-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("requires primary, checker, and mediator to reach VERIFIED_PASS before final acceptance", () => {
    const roles = [
      verifiedParams({
        role: "parent_runtime",
        childRunId: "run-wave8-primary",
        childSessionKey: "agent:main:subagent:wave8-primary",
      }),
      verifiedParams({
        role: "checker",
        childRunId: "run-wave8-checker",
        childSessionKey: "agent:main:subagent:wave8-checker",
      }),
      verifiedParams({
        role: "mediator",
        childRunId: "run-wave8-mediator",
        childSessionKey: "agent:main:subagent:wave8-mediator",
      }),
    ];

    const verified = roles.map((params) => classifyChildResultContract({ ...params }));
    expect(verified.map((classification) => classification.normalizedState)).toEqual([
      "VERIFIED_PASS",
      "VERIFIED_PASS",
      "VERIFIED_PASS",
    ]);
    expect(verified.every(satisfiesAcceptanceGate)).toBe(true);

    const unverifiedMediatorParams = verifiedParams({
      role: "mediator",
      childRunId: "run-wave8-unverified-mediator",
      childSessionKey: "agent:main:subagent:wave8-unverified-mediator",
    });
    const schemaValidButUnverifiedMediator = classifyChildResultContract({
      ...unverifiedMediatorParams,
      parentRuntimeEvidence: undefined,
    });

    expect(schemaValidButUnverifiedMediator.parsedReport?.schemaValid).toBe(true);
    expect(schemaValidButUnverifiedMediator.normalizedState).toBe("UNVERIFIED");
    expect(schemaValidButUnverifiedMediator.evidenceVerifier?.decision).toBe("EVIDENCE_UNVERIFIED");
    expect(satisfiesAcceptanceGate(schemaValidButUnverifiedMediator)).toBe(false);
    expect(
      [...verified.slice(0, 2), schemaValidButUnverifiedMediator].every(satisfiesAcceptanceGate),
    ).toBe(false);
    expect(renderChildResultDashboardStatus(schemaValidButUnverifiedMediator)).toMatchObject({
      semanticStatus: "warning",
      notSuccessUnlessVerified: true,
    });
  });

  it("preserves normalized result, quarantine reference, and verifier decision as separate resume fields", () => {
    const rawBody = [
      "diff --git a/src/secret.ts b/src/secret.ts",
      "@@ -1,2 +1,3 @@",
      "+export const DO_NOT_RESUME_RAW_WAVE8 = true;",
    ].join("\n");
    const malformed = buildParentVisibleChildResult({
      rawText: rawBody,
      rawSource: "assistant_output",
      quarantineRoot: tmpPath("quarantine"),
      allowUnsafeQuarantineRoot: true,
      childRunId: "run-wave8-resume-malformed",
      childSessionKey: "agent:main:subagent:wave8-resume-malformed",
      requesterSessionKey: "agent:main:main",
      taskLabel: "wave8 restart resume malformed",
    });
    const unverifiedParams = verifiedParams({
      role: "checker",
      childRunId: "run-wave8-resume-unverified",
      childSessionKey: "agent:main:subagent:wave8-resume-unverified",
    });
    const unverified = classifyChildResultContract({
      ...unverifiedParams,
      parentRuntimeEvidence: undefined,
    });

    const resumeRecord = JSON.parse(
      JSON.stringify({
        normalizedResult: {
          normalizedState: malformed.sanitizedMetadata.normalizedState,
          contractVerdict: malformed.sanitizedMetadata.contractVerdict,
          classificationLabels: malformed.sanitizedMetadata.classificationLabels,
        },
        rawQuarantineReference: malformed.sanitizedMetadata.quarantine,
        verifierDecision: unverified.evidenceVerifier,
      }),
    );

    expect(resumeRecord.normalizedResult.normalizedState).toBe("MALFORMED");
    expect(resumeRecord.rawQuarantineReference).toMatchObject({
      artifactId: expect.stringMatching(/^q_/),
      payloadSha256: sha256Text(rawBody),
      payloadStored: true,
    });
    expect(resumeRecord.verifierDecision).toMatchObject({
      decision: "EVIDENCE_UNVERIFIED",
      acceptanceEligible: false,
      parentObserved: false,
    });
    expect(JSON.stringify(resumeRecord)).not.toContain("DO_NOT_RESUME_RAW_WAVE8");
    expect(malformed.parentVisibleText).not.toContain("DO_NOT_RESUME_RAW_WAVE8");
  });

  it("prevents concurrent child evidence/session cross-contamination", () => {
    const childA = verifiedParams({
      role: "parent_runtime",
      childRunId: "run-wave8-concurrent-a",
      childSessionKey: "agent:main:subagent:wave8-concurrent-a",
      artifactName: "concurrent-a/report.json",
      logName: "concurrent-a/gate.log",
    });
    const childB = verifiedParams({
      role: "parent_runtime",
      childRunId: "run-wave8-concurrent-b",
      childSessionKey: "agent:main:subagent:wave8-concurrent-b",
      artifactName: "concurrent-b/report.json",
      logName: "concurrent-b/gate.log",
    });

    const acceptedA = classifyChildResultContract({ ...childA });
    const contaminatedB = classifyChildResultContract({
      ...childB,
      parentRuntimeEvidence: childA.parentRuntimeEvidence,
    });
    const acceptedB = classifyChildResultContract({ ...childB });

    expect(satisfiesAcceptanceGate(acceptedA)).toBe(true);
    expect(contaminatedB.normalizedState).toBe("UNVERIFIED");
    expect(contaminatedB.acceptanceEligible).toBe(false);
    expect(contaminatedB.evidenceVerifier?.reasons.join("\n")).toContain(
      "PARENT_RUNTIME_CHILD_RUN_ID_MISMATCH",
    );
    expect(contaminatedB.evidenceVerifier?.reasons.join("\n")).toContain(
      "PARENT_ARTIFACT_EVIDENCE_MISSING",
    );
    expect(satisfiesAcceptanceGate(acceptedB)).toBe(true);
    expect(contaminatedB.evidenceVerifier?.verifiedArtifacts).toBeUndefined();
  });

  it("drills rollback to DIRECT_VERIFICATION_REQUIRED without disabling raw-output protections", () => {
    const mode = resolveChildResultRolloutMode({
      stage: 3,
      acceptanceEnforcement: true,
      rollbackAcceptanceEnforcement: true,
      quarantineEnabled: false,
      compactionSanitationEnabled: false,
      rawOutputExclusionEnabled: false,
      emergencyRawOpen: true,
    });

    expect(mode).toMatchObject({
      acceptanceEnforcement: false,
      enforcementDisposition: "DIRECT_VERIFICATION_REQUIRED",
      quarantineRequired: true,
      compactionSanitationRequired: true,
      rawOutputExclusionRequired: true,
      rawChildOutputParentContext: "excluded",
      emergencyRawOpen: "isolated_raw_viewer_only",
      rollbackFailClosed: true,
    });
    expect(mode.reasons).toEqual(
      expect.arrayContaining([
        "ROLLBACK_ACCEPTANCE_ENFORCEMENT_DISABLED_TO_DIRECT_VERIFICATION_REQUIRED",
        "QUARANTINE_UNAVAILABLE_FAIL_CLOSED",
        "COMPACTION_SANITATION_UNAVAILABLE_FAIL_CLOSED",
        "RAW_OUTPUT_EXCLUSION_UNAVAILABLE_FAIL_CLOSED",
      ]),
    );
  });
});
