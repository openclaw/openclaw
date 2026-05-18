import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_MEMORY_TIMEOUT,
  ACTIVE_MEMORY_UNAVAILABLE,
  ACTIVE_TASK_CONTRACT_MISSING_VERDICT,
  ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
  ACTIVE_TASK_EXTENDED_CONTRACT_REQUIRED,
  ACTIVE_TASK_PRIORITY_CONFLICT,
  ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND,
  ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS,
  activeMemoryLookupSignalToPriorityHint,
  buildActiveTaskChildCompletionDedupeKey,
  buildActiveTaskStatusCardData,
  classifyChildCompletionAgainstActiveTask,
  createActiveTaskContract,
  evaluateActiveTaskArtifactPostflightEligibility,
  preflightActiveTaskExpectedOutputArtifacts,
  readActiveTaskContractFromEnv,
  writeActiveTaskExpectedOutputArtifactStub,
  resolveActiveTaskCurrentRequest,
  type ActiveTaskContract,
  type ActiveTaskContractInput,
} from "./subagent-active-task-contract.js";
import { dedupeLatestChildCompletionRows } from "./subagent-announce-output.js";
import { buildChildCompletionResultHash } from "./subagent-child-result-contract.js";

function activeContract(overrides: ActiveTaskContractInput = {}): ActiveTaskContract {
  const taskId = typeof overrides.taskId === "string" ? overrides.taskId : "session-audit-00117";
  const validation = createActiveTaskContract({
    contractId: taskId,
    taskId,
    sessionId: "session:tui-c7a5",
    createdFromUserTurnId: "turn-00117",
    createdAt: "2026-05-17T20:08:00.000Z",
    runId: "run-session-audit-00117",
    authorizationSourcePath: "/tmp/session-audit-report.json",
    authorizationSourceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authorizedRootIssue: "session-audit-00117",
    allowedAutomationActions: ["write_report_artifact"],
    maxFanout: 1,
    staleContextConflictPolicy: ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS,
    currentUserRequest: "Audit session:tui-c7a5 and write the requested session issue report.",
    inputArtifacts: [{ path: "docs/reports/session-issues-2026-05-17/primary.md" }],
    expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    allowedSideEffects: ["write_report_artifact"],
    authorizationSource: { kind: "current_user_request", sessionKey: "session:tui-c7a5" },
    nonGoals: ["implement stale markdown plan"],
    ...overrides,
  });
  if (!validation.ok) {
    throw new Error(`invalid fixture contract: ${JSON.stringify(validation.issues)}`);
  }
  return validation.contract;
}

describe("active task contract kernel", () => {
  it("reads and normalizes ACTIVE_TASK_CONTRACT JSON from the environment", () => {
    const contract = activeContract();
    const read = readActiveTaskContractFromEnv({ ACTIVE_TASK_CONTRACT: JSON.stringify(contract) });

    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected contract to parse");
    }
    expect(read.activeTaskContractId).toBe("session-audit-00117");
    expect(read.contract.currentUserRequest).toBe(
      "Audit session:tui-c7a5 and write the requested session issue report.",
    );

    const missing = readActiveTaskContractFromEnv({});
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      throw new Error("expected missing contract to fail");
    }
    expect(missing.contractVerdict).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);
  });

  it("normalizes extended recovery fields and derives the durable contract id", () => {
    const contract = activeContract({
      taskId: "session-audit-00117",
      contractId: "contract-00117",
    });
    const read = readActiveTaskContractFromEnv({ ACTIVE_TASK_CONTRACT: JSON.stringify(contract) });

    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected contract to parse");
    }
    expect(read.activeTaskContractId).toBe("contract-00117");
    expect(read.contract).toMatchObject({
      contractId: "contract-00117",
      sessionId: "session:tui-c7a5",
      createdFromUserTurnId: "turn-00117",
      createdAt: "2026-05-17T20:08:00.000Z",
      runId: "run-session-audit-00117",
      authorizationSourcePath: "/tmp/session-audit-report.json",
      authorizationSourceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      authorizedRootIssue: "session-audit-00117",
      allowedAutomationActions: ["write_report_artifact"],
      maxFanout: 1,
      staleContextConflictPolicy: ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS,
    });
  });

  it("keeps Wave 1A minimal contracts readable but ineligible for acceptance gates", () => {
    const minimal = createActiveTaskContract({
      taskId: "minimal-task",
      currentUserRequest: "Answer the latest user request.",
      inputArtifacts: [],
      expectedOutputArtifacts: [],
      allowedSideEffects: [],
      authorizationSource: { kind: "current_user_request" },
      nonGoals: [],
    });
    expect(minimal.ok).toBe(true);
    if (!minimal.ok) {
      throw new Error("expected minimal contract to remain readable");
    }

    const classification = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: minimal.contract,
      childTaskId: "minimal-task",
      outputArtifactPaths: [],
    });
    expect(classification.acceptanceEligible).toBe(false);
    expect(classification.reasons.join("\n")).toContain(ACTIVE_TASK_EXTENDED_CONTRACT_REQUIRED);

    const priority = resolveActiveTaskCurrentRequest({ activeTaskContract: minimal.contract });
    expect(priority.ok).toBe(true);
    if (!priority.ok) {
      throw new Error("expected current request to resolve from minimal contract");
    }
    expect(priority.currentUserRequest).toBe("Answer the latest user request.");
  });

  it("fails closed for invalid active task contracts", () => {
    const invalid = createActiveTaskContract({
      taskId: "session-audit-00117",
      inputArtifacts: [],
      expectedOutputArtifacts: [],
      allowedSideEffects: [],
      authorizationSource: { kind: "current_user_request" },
      nonGoals: [],
    });

    expect(invalid.ok).toBe(false);
    if (invalid.ok) {
      throw new Error("expected invalid contract to fail");
    }
    expect(invalid.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
    expect(invalid.issues.map((issue) => issue.field)).toContain("currentUserRequest");

    const classification = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: { taskId: "missing-fields" },
      childTaskId: "missing-fields",
    });
    expect(classification.acceptanceEligible).toBe(false);
    expect(classification.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
  });

  it("rejects a valid-looking child report written to an uncontracted path", () => {
    const contract = activeContract({
      expectedOutputArtifacts: [{ path: "/tmp/contracted-session-audit-report.json" }],
    });

    const artifact = evaluateActiveTaskArtifactPostflightEligibility({
      activeTaskContract: contract,
      outputArtifactPath: "/tmp/uncontracted-pass-report.json",
    });
    expect(artifact.acceptanceEligible).toBe(false);
    expect(artifact.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
    expect(artifact.reasons).toContain("OUTPUT_ARTIFACT_NOT_CONTRACTED");

    const classification = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: contract,
      childTaskId: "session-audit-00117",
      outputArtifactPaths: ["/tmp/uncontracted-pass-report.json"],
    });
    expect(classification.acceptanceEligible).toBe(false);
    expect(classification.currentTaskOutput).toBe(true);
    expect(classification.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
  });

  it("keeps the current session-audit request ahead of stale memory and compaction hints", () => {
    const contract = activeContract({
      taskId: "session-audit-00117",
      currentUserRequest: "Audit session:tui-c7a5 and summarize runtime issues.",
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });

    const priority = resolveActiveTaskCurrentRequest({
      activeTaskContract: contract,
      backgroundHints: [
        {
          source: "memory",
          taskId: "old-md-implementation",
          currentUserRequest: "Implement the old markdown plan.",
        },
        {
          source: "compaction",
          currentUserRequest: "Continue implementation of the stale MD deliverable.",
        },
        {
          source: "active-memory",
          activeTaskContractId: "old-md-contract",
          taskId: "old-md-implementation",
          currentUserRequest: "Implement the old markdown plan.",
          signal: ACTIVE_MEMORY_UNAVAILABLE,
        },
      ],
    });

    expect(priority.ok).toBe(true);
    if (!priority.ok) {
      throw new Error("expected task priority result");
    }
    expect(priority.currentUserRequest).toBe(
      "Audit session:tui-c7a5 and summarize runtime issues.",
    );
    expect(priority.taskPriorityConflicts).toHaveLength(3);
    expect(priority.taskPriorityConflicts.map((conflict) => conflict.reason)).toEqual([
      ACTIVE_TASK_PRIORITY_CONFLICT,
      ACTIVE_TASK_PRIORITY_CONFLICT,
      ACTIVE_TASK_PRIORITY_CONFLICT,
    ]);
    expect(priority.taskPriorityConflicts[2]).toMatchObject({
      source: "active-memory",
      ignoredActiveTaskContractId: "old-md-contract",
      signal: ACTIVE_MEMORY_UNAVAILABLE,
    });

    const statusCard = buildActiveTaskStatusCardData({
      activeTaskContract: contract,
      childTaskId: "session-audit-00117",
      outputArtifactPaths: ["/tmp/session-audit-report.json"],
      backgroundHints: [
        {
          source: "memory",
          taskId: "old-md-implementation",
          currentUserRequest: "Implement the old markdown plan.",
        },
      ],
    });
    expect(statusCard.activeTaskContractId).toBe("session-audit-00117");
    expect(statusCard.currentUserRequest).toBe(
      "Audit session:tui-c7a5 and summarize runtime issues.",
    );
    expect(statusCard.taskPriorityConflicts?.[0]?.reason).toBe(ACTIVE_TASK_PRIORITY_CONFLICT);
    expect(statusCard.expectedOutputArtifacts?.[0]).toMatchObject({
      artifactId: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
      status: "expected",
    });
    expect(JSON.stringify(statusCard.expectedOutputArtifacts)).not.toContain(
      "/tmp/session-audit-report.json",
    );
    expect(JSON.stringify(statusCard.expectedOutputArtifacts)).not.toContain('"path"');
  });

  it("keeps active-memory timeouts non-authorizing during child acceptance", () => {
    const contract = activeContract({
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
      allowedAutomationActions: ["write_report_artifact", "use_active_memory"],
      staleContextConflictPolicy: ACTIVE_TASK_STALE_CONTEXT_ALLOW_IN_SCOPE_BACKGROUND,
    });
    const timeoutHint = activeMemoryLookupSignalToPriorityHint({ status: "timeout" });
    expect(timeoutHint?.signal).toBe(ACTIVE_MEMORY_TIMEOUT);
    expect(activeMemoryLookupSignalToPriorityHint({ status: "timeout_partial" })?.signal).toBe(
      ACTIVE_MEMORY_TIMEOUT,
    );

    const statusCard = buildActiveTaskStatusCardData({
      activeTaskContract: contract,
      childTaskId: "session-audit-00117",
      outputArtifactPaths: ["/tmp/session-audit-report.json"],
      backgroundHints: [{ ...timeoutHint!, blocker: true, inScope: true }],
    });

    expect(statusCard.acceptanceEligible).toBe(true);
    expect(statusCard.currentUserRequest).toBe(
      "Audit session:tui-c7a5 and write the requested session issue report.",
    );
    expect(statusCard.taskPriorityConflicts).toBeUndefined();
    expect(statusCard.backgroundSignals?.[0]).toMatchObject({
      source: "active-memory",
      signal: ACTIVE_MEMORY_TIMEOUT,
      backgrounded: true,
      authorizing: false,
      blocking: false,
    });
  });

  it("backgrounds old blockers that are unrelated to the active task", () => {
    const contract = activeContract({
      taskId: "new-session-audit",
      contractId: "new-session-audit-contract",
      currentUserRequest: "Audit the current session, not the old implementation blocker.",
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });

    const priority = resolveActiveTaskCurrentRequest({
      activeTaskContract: contract,
      backgroundHints: [
        {
          source: "prior-task-blocker",
          taskId: "old-md-implementation",
          currentUserRequest: "Blocked on the stale markdown implementation.",
          blocker: true,
        },
      ],
    });

    expect(priority.ok).toBe(true);
    if (!priority.ok) {
      throw new Error("expected task priority result");
    }
    expect(priority.currentUserRequest).toBe(
      "Audit the current session, not the old implementation blocker.",
    );
    expect(priority.taskPriorityConflicts[0]?.reason).toBe(ACTIVE_TASK_PRIORITY_CONFLICT);
    expect(priority.backgroundSignals[0]).toMatchObject({
      source: "prior-task-blocker",
      backgrounded: true,
      blocking: false,
      authorizing: false,
    });
  });

  it("keeps a new task active when prior-task memory and active-memory metadata conflict", () => {
    const contract = activeContract({
      taskId: "new-session-audit",
      contractId: "new-session-audit-contract",
      currentUserRequest: "Audit the current session and report runtime safety issues.",
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });
    const activeMemoryHint = activeMemoryLookupSignalToPriorityHint({
      status: "unavailable",
      activeTaskContractId: "old-md-contract",
      taskId: "old-md-implementation",
      currentUserRequest: "Implement the old markdown plan.",
    });

    const priority = resolveActiveTaskCurrentRequest({
      activeTaskContract: contract,
      backgroundHints: [
        {
          source: "prior-task-memory",
          taskId: "old-md-implementation",
          currentUserRequest: "Resume implementing the old markdown plan.",
        },
        activeMemoryHint!,
      ],
    });

    expect(priority.ok).toBe(true);
    if (!priority.ok) {
      throw new Error("expected task priority result");
    }
    expect(priority.currentUserRequest).toBe(
      "Audit the current session and report runtime safety issues.",
    );
    expect(priority.taskPriorityConflicts).toHaveLength(2);
    expect(priority.taskPriorityConflicts.map((conflict) => conflict.reason)).toEqual([
      ACTIVE_TASK_PRIORITY_CONFLICT,
      ACTIVE_TASK_PRIORITY_CONFLICT,
    ]);
    expect(priority.backgroundSignals[1]).toMatchObject({
      source: "active-memory",
      signal: ACTIVE_MEMORY_UNAVAILABLE,
      backgrounded: true,
      authorizing: false,
    });
  });

  it("backgrounds a child event from another task id and scopes dedupe by active contract id", () => {
    const currentContract = activeContract({
      taskId: "session-audit-00117",
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });
    const staleContract = activeContract({
      taskId: "old-md-implementation",
      currentUserRequest: "Implement the old markdown plan.",
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });

    const staleChild = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: currentContract,
      childTaskId: "old-md-implementation",
      outputArtifactPaths: ["/tmp/session-audit-report.json"],
    });
    expect(staleChild.currentTaskOutput).toBe(false);
    expect(staleChild.backgrounded).toBe(true);
    expect(staleChild.acceptanceEligible).toBe(false);

    const resultHash = buildChildCompletionResultHash("PASS\n");
    expect(resultHash).toBe(buildChildCompletionResultHash("PASS"));

    const currentKey = buildActiveTaskChildCompletionDedupeKey({
      activeTaskContract: currentContract,
      childRunId: "run-1",
      childSessionId: "child-session-1",
      childSessionKey: "agent:main:subagent:child",
      childTaskId: "session-audit-00117",
      resultHash,
    });
    const staleKey = buildActiveTaskChildCompletionDedupeKey({
      activeTaskContract: staleContract,
      childRunId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      childTaskId: "old-md-implementation",
      resultHash,
    });
    expect(currentKey.key).toBe(
      `activeTaskContractId=session-audit-00117|childRunId=run-1|childSessionId=child-session-1|taskId=session-audit-00117|resultHash=${resultHash}`,
    );
    expect(staleKey.key).toContain("activeTaskContractId=old-md-implementation");
    expect(staleKey.key).toContain(`resultHash=${resultHash}`);
    expect(currentKey.key).not.toBe(staleKey.key);

    const deduped = dedupeLatestChildCompletionRows([
      {
        activeTaskContractId: "session-audit-00117",
        childSessionKey: "agent:main:subagent:child",
        task: "session audit",
        createdAt: 1,
        frozenResultText: "PASS",
      },
      {
        activeTaskContractId: "old-md-implementation",
        childSessionKey: "agent:main:subagent:child",
        task: "old markdown implementation",
        createdAt: 2,
        frozenResultText: "PASS",
      },
    ]);
    expect(deduped).toHaveLength(2);
  });

  it("makes acceptance-gated child results ineligible when the active task contract is missing", () => {
    const classification = classifyChildCompletionAgainstActiveTask({
      childTaskId: "session-audit-00117",
      outputArtifactPaths: ["/tmp/session-audit-report.json"],
    });
    expect(classification.acceptanceEligible).toBe(false);
    expect(classification.contractVerdict).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);

    const artifact = evaluateActiveTaskArtifactPostflightEligibility({
      outputArtifactPath: "/tmp/session-audit-report.json",
    });
    expect(artifact.acceptanceEligible).toBe(false);
    expect(artifact.contractVerdict).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);

    const statusCard = buildActiveTaskStatusCardData({
      childTaskId: "session-audit-00117",
      outputArtifactPaths: ["/tmp/session-audit-report.json"],
    });
    expect(statusCard.acceptanceEligible).toBe(false);
    expect(statusCard.contractVerdict).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);
  });

  it("rejects expected output artifact contracts when no child output artifacts are reported", () => {
    const contract = activeContract({
      expectedOutputArtifacts: [{ path: "/tmp/session-audit-report.json" }],
    });

    const omittedArtifacts = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: contract,
      childTaskId: "session-audit-00117",
    });
    expect(omittedArtifacts.acceptanceEligible).toBe(false);
    expect(omittedArtifacts.currentTaskOutput).toBe(true);
    expect(omittedArtifacts.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
    expect(omittedArtifacts.reasons).toContain("EXPECTED_OUTPUT_ARTIFACTS_UNVERIFIED");

    const emptyArtifacts = classifyChildCompletionAgainstActiveTask({
      activeTaskContract: contract,
      childTaskId: "session-audit-00117",
      outputArtifactPaths: [],
    });
    expect(emptyArtifacts.acceptanceEligible).toBe(false);
    expect(emptyArtifacts.currentTaskOutput).toBe(true);
    expect(emptyArtifacts.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
    expect(emptyArtifacts.reasons).toContain("EXPECTED_OUTPUT_ARTIFACTS_UNVERIFIED");
  });

  it("preflights exact expected artifacts and writes an early stub only at the contracted path", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-active-task-artifacts-"));
    try {
      const expectedPath = path.join(tmpRoot, "reports", "wave3-verdict.json");
      const wrongPath = path.join(tmpRoot, "reports", "wrong-verdict.json");
      const contract = activeContract({
        expectedOutputArtifacts: [{ path: expectedPath, schema: "child-result-report" }],
      });

      const preflight = preflightActiveTaskExpectedOutputArtifacts({
        activeTaskContract: contract,
        nowMs: 1_000,
      });
      expect(preflight.ok).toBe(true);
      if (!preflight.ok) {
        throw new Error("expected preflight to pass");
      }
      expect(preflight.activeTaskContractId).toBe("session-audit-00117");
      expect(preflight.reservations).toHaveLength(1);
      expect(preflight.reservations[0]).toMatchObject({
        path: expectedPath,
        freshAfterMs: 1_000,
        existedBeforeReservation: false,
      });
      expect(fs.existsSync(path.dirname(expectedPath))).toBe(true);

      const wrongStub = writeActiveTaskExpectedOutputArtifactStub({
        activeTaskContract: contract,
        outputArtifactPath: wrongPath,
      });
      expect(wrongStub.ok).toBe(false);
      if (wrongStub.ok) {
        throw new Error("expected wrong-path stub write to fail");
      }
      expect(wrongStub.contractVerdict).toBe(ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT);
      expect(wrongStub.reasons).toContain("OUTPUT_ARTIFACT_NOT_CONTRACTED");
      expect(fs.existsSync(wrongPath)).toBe(false);

      const stub = writeActiveTaskExpectedOutputArtifactStub({
        activeTaskContract: contract,
        outputArtifactPath: expectedPath,
        nowMs: 1_500,
      });
      expect(stub.ok).toBe(true);
      if (!stub.ok) {
        throw new Error("expected stub write to pass");
      }
      expect(stub.path).toBe(expectedPath);
      expect(stub.sizeBytes).toBeGreaterThan(0);
      expect(stub.sha256).toMatch(/^[a-f0-9]{64}$/);
      const stubBody = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      expect(stubBody).toMatchObject({
        kind: "active_task_expected_output_stub",
        activeTaskContractId: "session-audit-00117",
        path: expectedPath,
        verdict: "PENDING",
        stub: true,
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
