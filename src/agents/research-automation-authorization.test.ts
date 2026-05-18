import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID,
  STATE_DERIVED_STALE,
  normalizeCanonicalStateStatus,
  queryCanonicalOrchestratorState,
  type CanonicalOrchestratorStateQuery,
} from "./orchestrator-state-query.js";
import {
  RESEARCH_AUTOMATION_DECISION_FIRED,
  RESEARCH_AUTOMATION_DECISION_SUPPRESSED,
  RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED,
  RESEARCH_REASON_AUTOMATION_ALLOWED,
  RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH,
  RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED,
  RESEARCH_REASON_FROZEN_WINDOW_MISMATCH,
  RESEARCH_REASON_ISSUE_STATE_NOT_READY,
  RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED,
  RESEARCH_REASON_MAX_FANOUT_EXCEEDED,
  RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT,
  RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING,
  evaluateResearchAutomationAuthorization,
  type ResearchFrozenAuthorizationWindow,
} from "./research-automation-authorization.js";
import {
  ACTIVE_TASK_CONTRACT_MISSING_VERDICT,
  ACTIVE_TASK_PRIORITY_CONFLICT,
  ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS,
  createActiveTaskContract,
  type ActiveTaskContract,
  type ActiveTaskContractInput,
} from "./subagent-active-task-contract.js";

const NOW_MS = Date.parse("2026-05-17T21:00:00.000Z");
const ROOT = "issue-wave6-root";
const CONTRACT_ID = "research-contract-wave6";
const AUTH_SOURCE = "current user turn authorizes Wave 6 research fanout";
const AUTH_HASH = createHash("sha256").update(AUTH_SOURCE).digest("hex");

function activeContract(overrides: ActiveTaskContractInput = {}): ActiveTaskContract {
  const validation = createActiveTaskContract({
    contractId: CONTRACT_ID,
    taskId: "wave6-research-authorization",
    sessionId: "session:tui-c7a5",
    createdFromUserTurnId: "turn-current",
    createdAt: "2026-05-17T20:59:00.000Z",
    expiresAt: "2026-05-17T22:00:00.000Z",
    runId: "run-wave6-current",
    authorizationSourcePath: "/tmp/wave6-current-user-turn.txt",
    authorizationSourceHash: AUTH_HASH,
    authorizedRootIssue: ROOT,
    allowedAutomationActions: [
      "manual_research",
      "auto_research",
      "autoresearch",
      "research_automation",
      "research_fanout",
      "fanout",
      "continuation",
      "finalization",
      "authorization_sensitive_spawn",
    ],
    maxFanout: 2,
    staleContextConflictPolicy: ACTIVE_TASK_STALE_CONTEXT_CURRENT_USER_REQUEST_WINS,
    currentUserRequest: "Current-turn bounded research for Wave 6 issue authorization.",
    inputArtifacts: [],
    expectedOutputArtifacts: [],
    allowedSideEffects: [],
    authorizationSource: {
      kind: "current_user_request",
      sessionKey: "session:tui-c7a5",
      turnId: "turn-current",
    },
    nonGoals: ["resume historical project-initiation autoresearch"],
    ...overrides,
  });
  if (!validation.ok) {
    throw new Error(`invalid fixture contract: ${JSON.stringify(validation.issues)}`);
  }
  return validation.contract;
}

function frozenWindow(
  overrides: Partial<ResearchFrozenAuthorizationWindow> = {},
): ResearchFrozenAuthorizationWindow {
  return {
    contractId: CONTRACT_ID,
    sessionId: "session:tui-c7a5",
    createdFromUserTurnId: "turn-current",
    authorizedRootIssue: ROOT,
    authorizationSourceHash: AUTH_HASH,
    allowedAutomationActions: ["manual_research", "auto_research", "research_fanout"],
    maxFanout: 2,
    createdAt: "2026-05-17T20:59:00.000Z",
    expiresAt: "2026-05-17T22:00:00.000Z",
    runId: "run-wave6-current",
    ...overrides,
  };
}

function writeStateFixture(params: {
  contract?: ActiveTaskContract;
  rootIssue?: string;
  issueStatus?: unknown;
  orchestratorPhase?: unknown;
  stateMd?: string;
  issueId?: string;
}): { stateDir: string; query: CanonicalOrchestratorStateQuery } {
  const contract = params.contract ?? activeContract();
  const rootIssue = params.rootIssue ?? ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave6-state-"));
  const stateDir = path.join(dir, "state");
  const issuesDir = path.join(stateDir, "issues");
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "orchestrator.json"),
    JSON.stringify({
      phase: params.orchestratorPhase ?? "ready",
      activeTaskContractId: contract.contractId,
      authorizedRootIssue: rootIssue,
      authorizationSourceHash: contract.authorizationSourceHash,
    }),
  );
  fs.writeFileSync(
    path.join(issuesDir, `${params.issueId ?? rootIssue}.json`),
    JSON.stringify({
      id: params.issueId ?? rootIssue,
      rootIssue,
      status: params.issueStatus ?? "ready",
      activeTaskContractId: contract.contractId,
      authorizedRootIssue: rootIssue,
      authorizationSourceHash: contract.authorizationSourceHash,
    }),
  );
  if (params.stateMd) {
    fs.writeFileSync(path.join(dir, "STATE.md"), params.stateMd);
  }
  return {
    stateDir,
    query: queryCanonicalOrchestratorState({ stateDir, rootIssue, nowMs: NOW_MS }),
  };
}

type ResearchGateParams = Parameters<typeof evaluateResearchAutomationAuthorization>[0];

function baseGateParams(overrides: Partial<ResearchGateParams> = {}): ResearchGateParams {
  const contract = activeContract();
  const { query } = writeStateFixture({ contract });
  const { actionKind = "fanout", ...rest } = overrides;
  return {
    actionKind,
    activeTaskContract: contract,
    latestUserTurnId: "turn-current",
    authorizedRootIssue: ROOT,
    frozenWindow: frozenWindow(),
    stateQuery: query,
    truthBudgetLane: { truthReady: true, budgetReady: true, laneIsolated: true },
    authorizationSourceContent: AUTH_SOURCE,
    fanoutCount: 2,
    nowMs: NOW_MS,
    ...rest,
  };
}

describe("canonical orchestrator state query helper", () => {
  it("normalizes object-shaped issue statuses before research authorization", () => {
    const normalized = normalizeCanonicalStateStatus({ status: { state: "Human Review" } });
    expect(normalized.label).toBe("Human Review");
    expect(normalized.key).toBe("human-review");

    const contract = activeContract();
    const { query } = writeStateFixture({
      contract,
      issueStatus: { state: "Human Review" },
    });
    expect(query.helperId).toBe(CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID);
    expect(query.selectedIssue?.status.key).toBe("human-review");

    const result = evaluateResearchAutomationAuthorization({
      ...baseGateParams({ activeTaskContract: contract, stateQuery: query }),
      frozenWindow: frozenWindow(),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_ISSUE_STATE_NOT_READY);
  });

  it("detects derived STATE.md drift from authoritative orchestrator.json", () => {
    const contract = activeContract();
    const { query } = writeStateFixture({
      contract,
      orchestratorPhase: "blocked",
      stateMd: "status: ready\n",
    });
    expect(query.derivedStateStale).toBe(true);
    expect(query.derivedState?.reasonCode).toBe(STATE_DERIVED_STALE);

    const result = evaluateResearchAutomationAuthorization({
      ...baseGateParams({ activeTaskContract: contract, stateQuery: query }),
      frozenWindow: frozenWindow(),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(STATE_DERIVED_STALE);
    expect(result.decision.orchestratorStateHash).toBe(query.orchestrator?.sha256);
    expect(result.decision.issueStateHash).toBe(query.issueStateHash);
  });

  it("refuses state-like parser output without the canonical state-query helper id", () => {
    const params = baseGateParams();
    const adHocStateQuery = {
      ...params.stateQuery,
      helperId: "ad-hoc-status-parser",
    } as unknown as CanonicalOrchestratorStateQuery;

    const result = evaluateResearchAutomationAuthorization({
      ...params,
      stateQuery: adHocStateQuery,
    });

    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED);
  });
});

describe("research automation authorization gate", () => {
  it("suppresses auto-research and fanout when no current active contract exists", () => {
    const result = evaluateResearchAutomationAuthorization({
      actionKind: "autoresearch",
      latestUserTurnId: "turn-current",
      priorDecision: {
        decisionId: "historical-fired",
        actionKind: "autoresearch",
        decision: RESEARCH_AUTOMATION_DECISION_FIRED,
        reasonCode: RESEARCH_REASON_AUTOMATION_ALLOWED,
        blockedByConflict: false,
        spawnLineage: {},
        createdAt: "2026-05-16T00:00:00.000Z",
      },
      nowMs: NOW_MS,
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.decision).toBe(RESEARCH_AUTOMATION_DECISION_SUPPRESSED);
    expect(result.decision.reasonCode).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);
  });

  it("rejects old unrenewed active contracts even when frozen-window artifacts remain on disk", () => {
    const result = evaluateResearchAutomationAuthorization(
      baseGateParams({ latestUserTurnId: "turn-later" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT);
  });

  it("rejects expired frozen windows even when the active contract still matches", () => {
    const contract = activeContract({ expiresAt: undefined });
    const { query } = writeStateFixture({ contract });
    const result = evaluateResearchAutomationAuthorization(
      baseGateParams({
        activeTaskContract: contract,
        stateQuery: query,
        frozenWindow: frozenWindow({ expiresAt: "2026-05-17T20:00:00.000Z" }),
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_FROZEN_WINDOW_MISMATCH);
  });

  it("suppresses Human Review orchestrator phase through canonical state-query output", () => {
    const contract = activeContract();
    const { query } = writeStateFixture({ contract, orchestratorPhase: { state: "Human Review" } });
    const result = evaluateResearchAutomationAuthorization({
      ...baseGateParams({ activeTaskContract: contract, stateQuery: query }),
      frozenWindow: frozenWindow(),
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_ISSUE_STATE_NOT_READY);
  });

  it("suppresses Human Review or Blocked issues through canonical state-query output", () => {
    const contract = activeContract();
    const humanReview = writeStateFixture({ contract, issueStatus: { state: "Human Review" } });
    const blocked = writeStateFixture({ contract, issueStatus: "Blocked" });

    for (const stateQuery of [humanReview.query, blocked.query]) {
      const result = evaluateResearchAutomationAuthorization({
        ...baseGateParams({ activeTaskContract: contract, stateQuery }),
        frozenWindow: frozenWindow(),
      });
      expect(result.allowed).toBe(false);
      expect(result.decision.reasonCode).toBe(RESEARCH_REASON_ISSUE_STATE_NOT_READY);
      expect(result.decision.issueStateHash).toBe(stateQuery.issueStateHash);
    }
  });

  it("treats active-memory stale-task hints as TASK_PRIORITY_CONFLICT", () => {
    const result = evaluateResearchAutomationAuthorization(
      baseGateParams({
        backgroundHints: [
          {
            source: "active-memory",
            taskId: "old-wave-by-wave-plan",
            activeTaskContractId: "old-contract",
            currentUserRequest: "implement wave-by-wave",
          },
        ],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(ACTIVE_TASK_PRIORITY_CONFLICT);
    expect(result.decision.blockedByConflict).toBe(true);
  });

  it("does not treat detached child processes as task ownership", () => {
    const result = evaluateResearchAutomationAuthorization({
      actionKind: "project_initiation",
      latestUserTurnId: "turn-current",
      spawnLineage: {
        childSessionId: "agent:codex:subagent:stale",
        runId: "stale-run",
        childProcessOnly: true,
      },
      nowMs: NOW_MS,
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);
    expect(result.decision.spawnLineage.childProcessOnly).toBe(true);
  });

  it("keeps old project-initiation and historical approval artifacts non-authorizing", () => {
    const result = evaluateResearchAutomationAuthorization({
      actionKind: "finalization",
      latestUserTurnId: "turn-current",
      candidateAuthorizationEvidence: [
        { kind: "project_initiation_artifact", label: "READY_FOR_HUMAN_APPROVAL" },
        { kind: "historical_checkpoint", label: "FIRST_LOAD/wiki/navigation" },
        { kind: "research_automation_decision", label: "historical FIRED" },
      ],
      priorDecision: {
        decisionId: "historical-fired",
        actionKind: "finalization",
        decision: RESEARCH_AUTOMATION_DECISION_FIRED,
        reasonCode: RESEARCH_REASON_AUTOMATION_ALLOWED,
        blockedByConflict: false,
        spawnLineage: {},
        createdAt: "2026-05-16T00:00:00.000Z",
      },
      nowMs: NOW_MS,
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(ACTIVE_TASK_CONTRACT_MISSING_VERDICT);
  });

  it("suppresses autoresearch when the authorization source hash mismatches", () => {
    const result = evaluateResearchAutomationAuthorization(
      baseGateParams({
        actionKind: "autoresearch",
        frozenWindow: frozenWindow({ allowedAutomationActions: ["auto_research"] }),
        authorizationSourceContent: "stale blueprint body",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH);
  });

  it("suppresses authorization-sensitive fork/resume workers without explicit contract permission", () => {
    const contract = activeContract({
      allowedAutomationActions: ["manual_research", "research_fanout"],
    });
    const { query } = writeStateFixture({ contract });
    const result = evaluateResearchAutomationAuthorization({
      ...baseGateParams({ activeTaskContract: contract, stateQuery: query }),
      actionKind: "authorization_sensitive_spawn",
      frozenWindow: frozenWindow({ allowedAutomationActions: ["research_fanout"] }),
      spawnLineage: { contextMode: "fork", resumeMode: "resume" },
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED);
  });

  it("allows current-turn bounded manual research without frozen-window state gates", () => {
    const result = evaluateResearchAutomationAuthorization({
      actionKind: "manual_research",
      activeTaskContract: activeContract({ allowedAutomationActions: ["manual_research"] }),
      latestUserTurnId: "turn-current",
      authorizationSourceContent: AUTH_SOURCE,
      nowMs: NOW_MS,
    });
    expect(result.allowed).toBe(true);
    expect(result.decision.decision).toBe(RESEARCH_AUTOMATION_DECISION_FIRED);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED);
    expect(result.decision.frozenWindowHash).toBeUndefined();
  });

  it("allows current-turn orchestrated fanout with matching frozen window and authoritative state", () => {
    const result = evaluateResearchAutomationAuthorization(baseGateParams());
    expect(result.allowed).toBe(true);
    expect(result.decision.decision).toBe(RESEARCH_AUTOMATION_DECISION_FIRED);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_AUTOMATION_ALLOWED);
    expect(result.decision).toMatchObject({
      actionKind: "fanout",
      activeTaskContractId: CONTRACT_ID,
      latestUserTurnId: "turn-current",
      authorizedRootIssue: ROOT,
      authSourceHash: AUTH_HASH,
      blockedByConflict: false,
    });
    expect(result.decision.decisionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.decision.frozenWindowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.decision.orchestratorStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.decision.issueStateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("suppresses unbounded or nonsensical fanout counts", () => {
    for (const fanoutCount of [0, -1, 3, 1.5]) {
      const result = evaluateResearchAutomationAuthorization(baseGateParams({ fanoutCount }));
      expect(result.allowed).toBe(false);
      expect(result.decision.reasonCode).toBe(RESEARCH_REASON_MAX_FANOUT_EXCEEDED);
    }
  });

  it("requires existing truth, budget, and lane prerequisites before automation fires", () => {
    const result = evaluateResearchAutomationAuthorization(
      baseGateParams({
        truthBudgetLane: { truthReady: true, budgetReady: false, laneIsolated: true },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe(RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING);
  });
});
