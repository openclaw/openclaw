import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sha256Text,
  type ChildResultClassificationParams,
} from "./subagent-child-result-contract.js";
import {
  CHILD_RESULT_COMPATIBILITY_MATRIX,
  assertChildResultMetadataOnly,
  buildChildResultParserErrorTelemetry,
  buildChildResultShadowSafetySummary,
  buildChildResultTelemetryEvent,
  evaluateChildResultStageAdvancement,
  renderChildResultDashboardStatus,
  resolveChildResultRolloutMode,
  runChildResultReplayCorpus,
  runChildResultShadowVerifier,
  type ChildResultReplayCase,
} from "./subagent-child-result-rollout.js";

const FIXTURE_PATH = path.resolve(
  "test/fixtures/malformed-subagent-output-wave7-replay-corpus.json",
);

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wave7-rollout-"));
}

function readFixtureCases(): ChildResultReplayCase[] {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    cases: ChildResultReplayCase[];
  };
  return parsed.cases;
}

function withQuarantineRoot(
  testCase: ChildResultReplayCase,
  quarantineRoot: string,
): ChildResultReplayCase {
  return {
    ...testCase,
    classificationParams: {
      ...(testCase.classificationParams ?? {}),
      quarantineRoot,
      allowUnsafeQuarantineRoot: true,
    },
  };
}

function makeGoldenVerifiedCase(tmpRoot: string): ChildResultReplayCase {
  const artifactPath = path.join(tmpRoot, "golden-artifact.json");
  const logPath = path.join(tmpRoot, "golden-command.log");
  const artifactBody = JSON.stringify({ verdict: "PASS", checked: true });
  const logBody = "focused unit test passed\n";
  fs.writeFileSync(artifactPath, artifactBody, "utf8");
  fs.writeFileSync(logPath, logBody, "utf8");
  const artifactSha256 = sha256Text(artifactBody);
  const logSha256 = sha256Text(logBody);
  const observedAtMs = Date.now() + 2_000;
  const childRunId = "run_wave7_golden";
  const childSessionKey = "agent:main:subagent:wave7-golden";
  const classificationParams: ChildResultClassificationParams = {
    requireActiveTaskContract: false,
    childRunId,
    childSessionKey,
    spawnedAtMs: observedAtMs - 4_000,
    expectedOutputArtifacts: [
      { path: artifactPath, sha256: artifactSha256, schema: "child-result-report" },
    ],
    parentScopeCheck: { allowedChangedPaths: [], allowedSourcePaths: [] },
    scopedGateProcesses: [{ name: "focused-unit", status: "passed" }],
    parentRuntimeEvidence: {
      observedBy: "parent_runtime",
      observedAtMs,
      childRunId,
      childSessionKey,
      scope: {
        allowedChangedPaths: [],
        allowedSourcePaths: [],
        allowedArtifactPaths: [artifactPath],
        allowedLogPaths: [logPath],
      },
      artifacts: [
        {
          artifactId: "artifact_wave7_golden",
          path: artifactPath,
          sha256: artifactSha256,
          sizeBytes: Buffer.byteLength(artifactBody, "utf8"),
          observedAtMs,
          childRunId,
          childSessionKey,
        },
      ],
      commands: [
        {
          commandId: "cmd_wave7_golden",
          status: "passed",
          exitCode: 0,
          logPath,
          logSha256,
          observedAtMs,
          childRunId,
          childSessionKey,
        },
      ],
      logs: [
        {
          logId: "log_wave7_golden",
          path: logPath,
          sha256: logSha256,
          sizeBytes: Buffer.byteLength(logBody, "utf8"),
          observedAtMs,
          childRunId,
          childSessionKey,
        },
      ],
      staleProcessSweep: {
        status: "passed",
        noRunningProcesses: true,
        logId: "sweep_wave7_golden",
        logPath,
        logSha256,
        observedAtMs,
        childRunId,
        childSessionKey,
      },
    },
  };

  return {
    name: "golden-verified-pass-with-parent-evidence",
    group: "golden_fixtures",
    rawText: JSON.stringify({
      schemaVersion: 1,
      verdict: "PASS",
      outputArtifacts: [
        {
          artifactId: "artifact_wave7_golden",
          path: artifactPath,
          sha256: artifactSha256,
          sizeBytes: Buffer.byteLength(artifactBody, "utf8"),
        },
      ],
      commandsRun: [{ commandId: "cmd_wave7_golden", status: "passed", exitCode: 0 }],
    }),
    classificationParams,
    rateDimensions: {
      workerMode: "subagent",
      issueTaskType: "implementation",
      agentProfile: "default",
      taskLabel: "golden verified fixture",
      outputClass: "VERIFIED_PASS",
      promptContextTokenSize: 1200,
      childOutputSizeBytes: 200,
      fileCountRead: 2,
      fileBytesRead: Buffer.byteLength(artifactBody, "utf8"),
      fileCountTouched: 1,
      fileBytesTouched: Buffer.byteLength(artifactBody, "utf8"),
      logBytes: Buffer.byteLength(logBody, "utf8"),
      retryCount: 0,
      sourceHeavy: false,
      testHeavy: true,
      verdictArtifactRequired: true,
    },
    expected: {
      normalizedState: "VERIFIED_PASS",
      contractVerdict: "SCHEMA_VALID",
      acceptanceEligible: true,
      classificationLabels: ["SCHEMA_VALID"],
      dashboardSemanticStatus: "success",
    },
  };
}

function makeAdversarialCase(quarantineRoot: string): ChildResultReplayCase {
  return {
    name: "adversarial-raw-diff-downgrades-to-malformed",
    group: "adversarial_fixtures",
    rawText: [
      "diff --git a/src/leak.ts b/src/leak.ts",
      "@@ -1,3 +1,6 @@",
      "+const DO_NOT_LEAK_WAVE7_DIFF = true;",
      "+export function leak() {",
      "+  return DO_NOT_LEAK_WAVE7_DIFF;",
      "+}",
    ].join("\n"),
    classificationParams: {
      quarantineRoot,
      allowUnsafeQuarantineRoot: true,
    },
    rateDimensions: {
      workerMode: "subagent",
      issueTaskType: "adversarial_fixture",
      agentProfile: "default",
      taskLabel: "raw diff adversarial fixture",
      outputClass: "MALFORMED",
      sourceHeavy: true,
      testHeavy: false,
      verdictArtifactRequired: true,
    },
    expected: {
      normalizedState: "MALFORMED",
      contractVerdict: "MALFORMED_RAW_SOURCE_OUTPUT",
      acceptanceEligible: false,
      classificationLabels: ["RAW_DIFF_LIKE"],
      dashboardSemanticStatus: "error",
    },
  };
}

function expectMetadataOnly(value: unknown, forbiddenNeedles: string[]): void {
  const result = assertChildResultMetadataOnly(value, forbiddenNeedles);
  expect(result).toEqual({ ok: true });
}

describe("subagent child result Wave 7 rollout", () => {
  let tmpRoot: string;
  let oldQuarantineDir: string | undefined;

  beforeEach(() => {
    tmpRoot = makeTempRoot();
    oldQuarantineDir = process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = path.join(tmpRoot, "quarantine-env");
  });

  afterEach(() => {
    if (oldQuarantineDir === undefined) {
      delete process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
    } else {
      process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = oldQuarantineDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("runs shadow verification without gating and emits metadata-only telemetry", () => {
    const rawText = [
      "export function shadowLeak() {",
      "  return 'DO_NOT_LEAK_WAVE7_SHADOW';",
      "}",
      "export const anotherLeak = () => {",
      "  return shadowLeak();",
      "};",
      "if (anotherLeak()) {",
      "  console.log(anotherLeak());",
      "}",
    ].join("\n");

    const result = runChildResultShadowVerifier({
      classificationParams: {
        rawText,
        quarantineRoot: path.join(tmpRoot, "shadow-quarantine"),
        allowUnsafeQuarantineRoot: true,
      },
      rateDimensions: {
        workerMode: "subagent",
        issueTaskType: "implementation",
        agentProfile: "default",
        taskLabel: "sensitive task label /tmp/should-not-appear",
        outputClass: "raw_source",
        promptContextTokenSize: 4096,
        childOutputSizeBytes: Buffer.byteLength(rawText, "utf8"),
        fileCountRead: 4,
        fileBytesRead: 2048,
        fileCountTouched: 2,
        fileBytesTouched: 1024,
        logBytes: 512,
        retryCount: 1,
        sourceHeavy: true,
        testHeavy: false,
        verdictArtifactRequired: true,
      },
      emittedAt: "2026-05-18T12:00:00.000Z",
    });

    expect(result.gatingDecision).toBe("not_applied_shadow_mode");
    expect(result.existingWorkflowGateUnchanged).toBe(true);
    expect(result.normalizedState).toBe("MALFORMED");
    expect(result.telemetryEvent.counters.malformedOutputs).toBe(1);
    expect(result.telemetryEvent.displayableAsSafetyProof).toBe(false);
    expect(result.telemetryEvent.safetyProofStatus).toBe("shadow_metrics_only_not_proof");
    expect(result.telemetryEvent.dimensions.taskLabelHash).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(result.telemetryEvent)).not.toContain("task label /tmp");
    expectMetadataOnly(result.telemetryEvent, [rawText, "DO_NOT_LEAK_WAVE7_SHADOW", tmpRoot]);
  });

  it("counts downgraded passes, duplicate suppressions, profile mismatches, schema versions, and quarantine classes", () => {
    const unverifiedPass = runChildResultShadowVerifier({
      classificationParams: {
        rawText: JSON.stringify({ schemaVersion: 1, verdict: "PASS" }),
        requireActiveTaskContract: false,
      },
    });
    expect(unverifiedPass.telemetryEvent.counters.downgradedPasses).toBe(1);
    expect(unverifiedPass.telemetryEvent.counters.evidenceVerificationFailures).toBe(1);
    expect(unverifiedPass.telemetryEvent.counters.schemaVersions).toMatchObject({
      "1": 1,
      "report:1": 1,
    });

    const duplicate = runChildResultShadowVerifier({
      classificationParams: {
        rawText: "PASS duplicate",
        duplicateCompletion: true,
        quarantineRoot: path.join(tmpRoot, "duplicate-quarantine"),
        allowUnsafeQuarantineRoot: true,
      },
    });
    expect(duplicate.telemetryEvent.counters.duplicateSuppressions).toBe(1);
    expect(duplicate.telemetryEvent.counters.quarantineClasses).toMatchObject({
      DUPLICATE_ANNOUNCE_SUPPRESSED: 1,
    });

    const profileMismatchEvent = buildChildResultTelemetryEvent({
      classification: duplicate.classification,
      rawText: "BLOCKED_INFRA_PROFILE_MISMATCH should not leak as a body",
      profileMismatchBlocked: true,
      rateDimensions: {
        workerMode: "subagent",
        issueTaskType: "review /tmp/private",
        agentProfile: "read-only",
        taskLabel: "profile mismatch label",
      },
    });
    expect(profileMismatchEvent.counters.profileMismatchBlocks).toBe(1);
    expect(profileMismatchEvent.dimensions.issueTaskType).toBe("opaque");
    expect(profileMismatchEvent.dimensions.issueTaskTypeHash).toMatch(/^[a-f0-9]{32}$/);
    expectMetadataOnly(profileMismatchEvent, ["should not leak as a body", tmpRoot]);

    const missingArtifactPath = path.join(tmpRoot, "private", "missing-artifact.json");
    const missingArtifact = runChildResultShadowVerifier({
      classificationParams: {
        rawText: JSON.stringify({
          schemaVersion: 1,
          verdict: "PASS",
          outputArtifacts: [{ path: missingArtifactPath, sha256: "a".repeat(64), sizeBytes: 1 }],
        }),
        requireActiveTaskContract: false,
        expectedOutputArtifacts: [
          { path: missingArtifactPath, sha256: "a".repeat(64), schema: "child-result-report" },
        ],
      },
    });
    expect(missingArtifact.telemetryEvent.classification.reasonCodes).toEqual(
      expect.arrayContaining([
        "EXPECTED_OUTPUT_ARTIFACT_MISSING",
        expect.stringMatching(/^opaque_reason:opaque:[a-f0-9]{32}$/),
      ]),
    );
    expectMetadataOnly(missingArtifact.telemetryEvent, [missingArtifactPath, tmpRoot]);
  });

  it("replays the named corpus and golden/adversarial fixtures with metadata-only results", () => {
    const quarantineRoot = path.join(tmpRoot, "replay-quarantine");
    const cases = [
      ...readFixtureCases().map((testCase) => withQuarantineRoot(testCase, quarantineRoot)),
      makeGoldenVerifiedCase(tmpRoot),
      makeAdversarialCase(quarantineRoot),
    ];

    const report = runChildResultReplayCorpus(cases, {
      emittedAt: "2026-05-18T12:30:00.000Z",
      rolloutFlags: { stage: 1, classifyOnlyShadow: true },
    });

    expect(report.failed).toBe(0);
    expect(report.safetyProofStatus).toBe("replay_fixture_gates_satisfied");
    expect(report.displayableAsSafetyProof).toBe(true);
    expect(Object.keys(report.groups).sort()).toEqual(
      [
        "adversarial_fixtures",
        "clean_prose_only_subagents",
        "cron_background_tasks",
        "dashboard_session_history_views",
        "direct_queued_announcements",
        "golden_fixtures",
        "polluted_sessions",
        "read_only_auditors",
        "restart_resume_cases",
        "timeout_cancelled_children",
      ].sort(),
    );
    expect(
      report.results.find((entry) => entry.name === "dashboard-session-history-unverified-pass")
        ?.actual,
    ).toMatchObject({ normalizedState: "UNVERIFIED", dashboardSemanticStatus: "warning" });

    expectMetadataOnly(report, [
      "DO_NOT_LEAK_WAVE7_SOURCE",
      "DO_NOT_LEAK_WAVE7_ENVELOPE",
      "DO_NOT_LEAK_WAVE7_DIFF",
      tmpRoot,
    ]);
  });

  it("requires replay and threshold gates before Stage 2+ safety claims", () => {
    const shadowOnlySummary = buildChildResultShadowSafetySummary({ telemetryEvents: [] });
    expect(shadowOnlySummary.displayableAsSafetyProof).toBe(false);
    expect(shadowOnlySummary.status).toBe("shadow_metrics_only_not_proof");
    expect(shadowOnlySummary.warning).toContain("Shadow-mode metrics are diagnostic only");

    const blocked = evaluateChildResultStageAdvancement({
      targetStage: 2,
      rawBodyLeakCount: 1,
      schemaValidPassAcceptedWithoutEvidenceCount: 0,
      goldenAdversarialFixturePassRate: 1,
      compatibilityRegressionCount: 0,
      replayCorpusPassed: true,
      shadowBaselineCollected: true,
      rateThresholdsApproved: true,
      downgradedPassRateThreshold: 0.05,
      malformedClassificationRateThreshold: 0.1,
      quarantineGrowthRateThreshold: 10,
      falsePositiveUnverifiedMalformedRateThreshold: 0.01,
    });
    expect(blocked.canAdvance).toBe(false);
    expect(blocked.blockers).toContain("RAW_BODY_LEAKS_MUST_BE_ZERO");

    const allowed = evaluateChildResultStageAdvancement({
      targetStage: 2,
      rawBodyLeakCount: 0,
      schemaValidPassAcceptedWithoutEvidenceCount: 0,
      goldenAdversarialFixturePassRate: 1,
      compatibilityRegressionCount: 0,
      replayCorpusPassed: true,
      shadowBaselineCollected: true,
      rateThresholdsApproved: true,
      downgradedPassRateThreshold: 0.05,
      malformedClassificationRateThreshold: 0.1,
      quarantineGrowthRateThreshold: 10,
      falsePositiveUnverifiedMalformedRateThreshold: 0.01,
    });
    expect(allowed).toMatchObject({
      canAdvance: true,
      thresholdsDeclared: true,
      thresholdsSatisfied: true,
    });

    const proofSummary = buildChildResultShadowSafetySummary({
      telemetryEvents: [],
      replayReport: {
        schemaVersion: 1,
        verifierVersion: "wave7-shadow-verifier-v1",
        total: 1,
        passed: 1,
        failed: 0,
        safetyProofStatus: "replay_fixture_gates_satisfied",
        displayableAsSafetyProof: true,
        groups: { golden_fixtures: { total: 1, passed: 1, failed: 0 } },
        results: [],
      },
      stageDecision: allowed,
    });
    expect(proofSummary).toMatchObject({
      status: "replay_fixture_gates_satisfied",
      displayableAsSafetyProof: true,
    });
  });

  it("fails closed for rollback and keeps raw output excluded outside isolated raw viewer", () => {
    const mode = resolveChildResultRolloutMode({
      stage: 3,
      acceptanceEnforcement: true,
      rollbackAcceptanceEnforcement: true,
      quarantineEnabled: false,
      compactionSanitationEnabled: false,
      rawOutputExclusionEnabled: false,
      emergencyRawOpen: true,
    });

    expect(mode.acceptanceEnforcement).toBe(false);
    expect(mode.enforcementDisposition).toBe("DIRECT_VERIFICATION_REQUIRED");
    expect(mode.rollbackFailClosed).toBe(true);
    expect(mode.quarantineRequired).toBe(true);
    expect(mode.compactionSanitationRequired).toBe(true);
    expect(mode.rawOutputExclusionRequired).toBe(true);
    expect(mode.rawChildOutputParentContext).toBe("excluded");
    expect(mode.emergencyRawOpen).toBe("isolated_raw_viewer_only");
    expect(mode.reasons).toEqual(
      expect.arrayContaining([
        "ROLLBACK_ACCEPTANCE_ENFORCEMENT_DISABLED_TO_DIRECT_VERIFICATION_REQUIRED",
        "QUARANTINE_UNAVAILABLE_FAIL_CLOSED",
        "COMPACTION_SANITATION_UNAVAILABLE_FAIL_CLOSED",
        "RAW_OUTPUT_EXCLUSION_UNAVAILABLE_FAIL_CLOSED",
      ]),
    );
  });

  it("keeps parser errors, dashboard states, and compatibility mappings privacy-safe", () => {
    const parserError = buildChildResultParserErrorTelemetry({
      error: new Error("failed to parse /tmp/private/raw-body DO_NOT_LEAK_WAVE7_PARSE"),
      failedInput: "DO_NOT_LEAK_WAVE7_PARSE raw body with /tmp/private/path",
      emittedAt: "2026-05-18T12:45:00.000Z",
    });
    expect(parserError.failedInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expectMetadataOnly(parserError, ["DO_NOT_LEAK_WAVE7_PARSE", "/tmp/private"]);

    const unverified = runChildResultShadowVerifier({
      classificationParams: {
        rawText: JSON.stringify({ schemaVersion: 1, verdict: "PASS" }),
        requireActiveTaskContract: false,
      },
    });
    expect(renderChildResultDashboardStatus(unverified.classification)).toMatchObject({
      semanticStatus: "warning",
      normalizedState: "UNVERIFIED",
      acceptanceEligible: false,
      notSuccessUnlessVerified: true,
    });

    const consumers = CHILD_RESULT_COMPATIBILITY_MATRIX.map((entry) => entry.consumer).sort();
    expect(consumers).toEqual(
      [
        "cron_background_flows",
        "dashboards",
        "direct_announcements",
        "legacy_prose_only_agents",
        "queued_announcements",
        "read_only_auditors",
        "restart_resume",
        "session_history_search_export",
      ].sort(),
    );
    expect(CHILD_RESULT_COMPATIBILITY_MATRIX.every((entry) => entry.failClosedFallback)).toBe(true);
    expectMetadataOnly(CHILD_RESULT_COMPATIBILITY_MATRIX, []);
  });
});
