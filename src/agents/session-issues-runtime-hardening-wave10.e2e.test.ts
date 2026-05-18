import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- scripts/run-vitest.mjs is a checked ESM script without a declaration in src test config.
import { buildVitestProgressPulse } from "../../scripts/run-vitest.mjs";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  queryCanonicalOrchestratorState,
  STATE_DERIVED_STALE,
} from "./orchestrator-state-query.js";
import {
  evaluateResearchAutomationAuthorization,
  RESEARCH_AUTOMATION_DECISION_SUPPRESSED,
} from "./research-automation-authorization.js";
import {
  ACTIVE_MEMORY_TIMEOUT,
  ACTIVE_TASK_PRIORITY_CONFLICT,
  buildActiveTaskStatusCardData,
  createActiveTaskContract,
  resolveActiveTaskCurrentRequest,
  type ActiveTaskContract,
} from "./subagent-active-task-contract.js";
import {
  buildParentVisibleChildResult,
  CHILD_RESULT_DUPLICATE_COMPLETION,
  CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
} from "./subagent-child-result-contract.js";

const PLAN_PATH =
  "/root/.openclaw/workspace/docs/reports/session-issues-2026-05-17/session-issues-runtime-hardening-implementation-plan.md";
const FIXTURE_PATH = path.resolve("test/fixtures/session-issues-runtime-hardening-20260517.json");
const CURRENT_USER_REQUEST =
  "Finish Plan 1 Wave 10 runtime hardening for sessions 00116/00117; do not start Plan 2.";
const AUTH_HASH = "a".repeat(64);

type FixtureCorpus = {
  fixtures: Array<{
    id: string;
    waves: string[];
    expectedResultClass: string;
  }>;
};

function loadFixtureCorpus(): FixtureCorpus {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as FixtureCorpus;
}

function fixtureById(corpus: FixtureCorpus, id: string) {
  const fixture = corpus.fixtures.find((entry) => entry.id === id);
  if (!fixture) {
    throw new Error(`missing fixture ${id}`);
  }
  return fixture;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function activeContract(outputPath: string): ActiveTaskContract {
  const created = createActiveTaskContract({
    contractId: "session-issues-wave10-current-contract",
    taskId: "session-issues-runtime-hardening-wave10",
    sessionId: "session:tui-c7a5-00117",
    createdFromUserTurnId: "turn-00117-wave10",
    createdAt: "2026-05-18T00:00:00.000Z",
    expiresAt: "2026-05-18T04:00:00.000Z",
    runId: "run-wave10",
    authorizationSourcePath: "/tmp/session-issues-runtime-hardening-wave10-primary-report.json",
    authorizationSourceHash: AUTH_HASH,
    authorizedRootIssue: "session-issues-00116-00117",
    allowedAutomationActions: ["research:fanout", "write_report_artifact", "use_active_memory"],
    maxFanout: 2,
    staleContextConflictPolicy: "current_user_request_wins",
    currentUserRequest: CURRENT_USER_REQUEST,
    inputArtifacts: [{ path: PLAN_PATH }],
    expectedOutputArtifacts: [{ path: outputPath, schema: "child-result-report" }],
    allowedSideEffects: ["write_report_artifact"],
    authorizationSource: { kind: "current_user_request", sessionKey: "session:tui-c7a5-00117" },
    nonGoals: ["Plan 2 implementation", "gateway restart"],
  });
  if (!created.ok) {
    throw new Error(`invalid active contract fixture: ${JSON.stringify(created.issues)}`);
  }
  return created.contract;
}

function largeToolLog(sentinel: string): string {
  const nestedLogBody = sentinel.repeat(1_800);
  const log = [
    "$ pnpm vitest run src/agents/session-issues-runtime-hardening-wave10.e2e.test.ts",
    "[PLUGIN_TIMINGS] repeated timing output follows",
    "Process exited with code 1",
    "nested child log body follows; this simulates a >50 KiB child/tool dump",
    nestedLogBody,
  ].join("\n");
  expect(Buffer.byteLength(log, "utf8")).toBeGreaterThan(50 * 1024);
  return log;
}

function writeStateFixture(tmpRoot: string, contract: ActiveTaskContract) {
  const stateDir = path.join(tmpRoot, "state");
  const issuesDir = path.join(stateDir, "issues");
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "orchestrator.json"),
    `${JSON.stringify(
      {
        phase: "ready",
        activeTaskContractId: contract.contractId,
        authorizedRootIssue: contract.authorizedRootIssue,
        authorizationSourceHash: contract.authorizationSourceHash,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(issuesDir, "session-issues-00116-00117.json"),
    `${JSON.stringify(
      {
        id: "session-issues-00116-00117",
        status: { state: "ready" },
        activeTaskContractId: contract.contractId,
        authorizedRootIssue: contract.authorizedRootIssue,
        authorizationSourceHash: contract.authorizationSourceHash,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(tmpRoot, "STATE.md"), "## Phase\nBlocked\n");
  return { stateDir, stateMdPath: path.join(tmpRoot, "STATE.md") };
}

describe("Wave 10 session-issues runtime hardening integration", () => {
  it("covers stable 00116/00117 fixtures across progress, quarantine, compaction budget, dedupe, state, and research auth", () => {
    const corpus = loadFixtureCorpus();
    for (const [id, expectedClass] of [
      ["long-gate-progress", "PROGRESS_PULSE"],
      ["raw-log", "MALFORMED_TOOL_LOG_OUTPUT"],
      ["active-memory-timeout", "ACTIVE_MEMORY_TIMEOUT"],
      ["active-memory-conflict", "TASK_PRIORITY_CONFLICT"],
      ["duplicate-replay", "DUPLICATE_COMPLETION"],
      ["state-derived-mismatch", "STATE_DERIVED_STALE"],
      ["stale-autoresearch", "STALE_AUTHORIZATION_CONTRACT"],
    ] as const) {
      const fixture = fixtureById(corpus, id);
      expect(fixture.expectedResultClass).toBe(expectedClass);
      if (["long-gate-progress", "raw-log", "active-memory-timeout"].includes(id)) {
        expect(fixture.waves).toContain("10");
      }
    }

    const pulse = buildVitestProgressPulse({
      jobId: "wave10-e2e",
      planPath: PLAN_PATH,
      waveNumber: "10",
      waveTotal: "10",
      elapsedMs: 125_000,
      currentGate: "focused Wave 10 fixture gate",
      nextAction: "wait for focused gate result, then write report",
    });
    expect(pulse).toContain(`plan=${PLAN_PATH}`);
    expect(pulse).toContain("wave=10/10");
    expect(pulse).toContain("elapsed=2m5s");
    expect(pulse).not.toMatch(/approve|RAW_LOG_BODY_SENTINEL/i);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wave10-e2e-"));
    try {
      const reportPath = path.join(tmpRoot, "wave10-primary-report.json");
      const quarantineRoot = path.join(tmpRoot, "quarantine");
      const contract = activeContract(reportPath);
      const sentinel = "RAW_LOG_BODY_SENTINEL_00116_00117_";
      const rawLog = largeToolLog(sentinel);

      const parentVisible = buildParentVisibleChildResult({
        rawText: rawLog,
        rawSource: "tool_log",
        outcome: { status: "ok" },
        quarantineRoot,
        allowUnsafeQuarantineRoot: true,
        activeTaskContract: contract,
        childTaskId: contract.taskId,
      });
      expect(parentVisible.classification.contractVerdict).toBe(
        CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
      );
      expect(parentVisible.rawBodySuppressed).toBe(true);
      expect(parentVisible.parentVisibleText).not.toContain(sentinel);
      expect(parentVisible.classification.quarantineArtifact?.path).toBeTruthy();
      expect(
        fs.existsSync(
          requireString(parentVisible.classification.quarantineArtifact?.path, "quarantine path"),
        ),
      ).toBe(true);
      expect(parentVisible.classification.quarantineArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);

      const duplicateVisible = buildParentVisibleChildResult({
        rawText: rawLog,
        rawSource: "tool_log",
        outcome: { status: "ok" },
        duplicateCompletion: true,
        quarantineRoot,
        allowUnsafeQuarantineRoot: true,
        activeTaskContract: contract,
        childTaskId: contract.taskId,
      });
      expect(duplicateVisible.classification.contractVerdict).toBe(
        CHILD_RESULT_DUPLICATE_COMPLETION,
      );
      expect(duplicateVisible.parentVisibleText).not.toContain(sentinel);
      expect(duplicateVisible.classification.quarantineArtifact?.path).toBeTruthy();

      const priority = resolveActiveTaskCurrentRequest({
        activeTaskContract: contract,
        backgroundHints: [
          {
            source: "active-memory",
            activeTaskContractId: "old-plan-contract",
            taskId: "old-plan-2",
            currentUserRequest: "Start Plan 2 malformed subagent output work.",
            signal: ACTIVE_MEMORY_TIMEOUT,
          },
        ],
      });
      expect(priority.ok).toBe(true);
      if (!priority.ok) {
        throw new Error("expected active task priority to resolve");
      }
      expect(priority.currentUserRequest).toBe(CURRENT_USER_REQUEST);
      expect(priority.taskPriorityConflicts[0]).toMatchObject({
        reason: ACTIVE_TASK_PRIORITY_CONFLICT,
        source: "active-memory",
        ignoredActiveTaskContractId: "old-plan-contract",
        signal: ACTIVE_MEMORY_TIMEOUT,
      });

      const activeTaskStatus = buildActiveTaskStatusCardData({
        activeTaskContract: contract,
        childTaskId: contract.taskId,
        outputArtifactPaths: [reportPath],
        backgroundHints: [
          {
            source: "active-memory",
            activeTaskContractId: "old-plan-contract",
            taskId: "old-plan-2",
            currentUserRequest: "Start Plan 2 malformed subagent output work.",
            signal: ACTIVE_MEMORY_TIMEOUT,
          },
        ],
      });
      expect(activeTaskStatus.currentUserRequest).toBe(CURRENT_USER_REQUEST);
      expect(activeTaskStatus.taskPriorityConflicts?.[0]?.reason).toBe(
        ACTIVE_TASK_PRIORITY_CONFLICT,
      );

      const event: AgentInternalEvent = {
        type: "task_completion",
        source: "subagent",
        childSessionKey: "agent:main:subagent:wave10-e2e",
        childSessionId: "child-wave10-e2e",
        announceType: "subagent task",
        taskLabel: "Wave 10 fixture e2e",
        status: "ok",
        statusLabel: "child result quarantined; validation required",
        result: rawLog,
        replyInstruction:
          "Use only the bounded status card and quarantine pointer; do not paste raw logs.",
        statusCard: {
          kind: "subagent_completion_status",
          deliveryState: "quarantined",
          action: "validate_artifact_or_retry",
          transportOutcome: "completed",
          contractVerdict: CHILD_RESULT_MALFORMED_TOOL_LOG_OUTPUT,
          acceptanceEligible: false,
          reasons: ["RAW_TOOL_LOG_OUTPUT_SUPPRESSED"],
          quarantine: parentVisible.classification.quarantineArtifact!,
          rawBodySuppressed: true,
          userVisibleSuppressed: true,
          userVisibleSuppressedReason: "RAW_BODY_QUARANTINED",
          activeTask: activeTaskStatus,
        },
      };
      const previousQuarantineDir = process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
      let rendered = "";
      try {
        process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = quarantineRoot;
        rendered = formatAgentInternalEventsForPrompt([event], { maxBytes: 6_000 });
      } finally {
        if (previousQuarantineDir === undefined) {
          delete process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
        } else {
          process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = previousQuarantineDir;
        }
      }
      expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(6_000);
      expect(rendered).toContain(CURRENT_USER_REQUEST);
      expect(rendered).toContain(ACTIVE_MEMORY_TIMEOUT);
      expect(rendered).toContain(ACTIVE_TASK_PRIORITY_CONFLICT);
      expect(rendered).toContain("quarantine");
      expect(rendered).not.toContain(sentinel);
      expect(rendered).not.toContain("Process exited with code 1");

      const state = writeStateFixture(tmpRoot, contract);
      const stateQuery = queryCanonicalOrchestratorState({
        stateDir: state.stateDir,
        stateMdPath: state.stateMdPath,
        rootIssue: "session-issues-00116-00117",
        nowMs: Date.parse("2026-05-18T00:05:00.000Z"),
      });
      expect(stateQuery.derivedStateStale).toBe(true);
      expect(stateQuery.derivedState?.reasonCode).toBe(STATE_DERIVED_STALE);

      const research = evaluateResearchAutomationAuthorization({
        actionKind: "fanout",
        activeTaskContract: contract,
        latestUserTurnId: "turn-00117-wave10",
        authorizedRootIssue: "session-issues-00116-00117",
        stateQuery,
        backgroundHints: [
          {
            source: "active-memory",
            activeTaskContractId: "old-plan-contract",
            taskId: "old-plan-2",
            currentUserRequest: "Start Plan 2 malformed subagent output work.",
            signal: ACTIVE_MEMORY_TIMEOUT,
          },
        ],
        authorizationSourceContent: "current authorization content",
        nowMs: Date.parse("2026-05-18T00:05:00.000Z"),
      });
      expect(research.allowed).toBe(false);
      expect(research.decision.decision).toBe(RESEARCH_AUTOMATION_DECISION_SUPPRESSED);
      expect(research.reasons).toContain(ACTIVE_TASK_PRIORITY_CONFLICT);
      expect(research.decision.blockedByConflict).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
