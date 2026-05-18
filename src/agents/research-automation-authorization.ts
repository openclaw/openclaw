import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID,
  STATE_DERIVED_STALE,
  type CanonicalOrchestratorStateQuery,
} from "./orchestrator-state-query.js";
import {
  ACTIVE_TASK_CONTRACT_MISSING_VERDICT,
  ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT,
  ACTIVE_TASK_PRIORITY_CONFLICT,
  resolveActiveTaskCurrentRequest,
  validateActiveTaskContractForAcceptance,
  type ActiveTaskContract,
  type ActiveTaskPriorityHint,
} from "./subagent-active-task-contract.js";

export const RESEARCH_AUTOMATION_DECISION_FIRED = "FIRED" as const;
export const RESEARCH_AUTOMATION_DECISION_SUPPRESSED = "SUPPRESSED" as const;

export const RESEARCH_REASON_AUTOMATION_ALLOWED = "AUTOMATION_ALLOWED" as const;
export const RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED = "MANUAL_RESEARCH_ALLOWED" as const;
export const RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT = "STALE_AUTHORIZATION_CONTRACT" as const;
export const RESEARCH_REASON_FROZEN_WINDOW_MISSING = "FROZEN_WINDOW_MISSING" as const;
export const RESEARCH_REASON_FROZEN_WINDOW_MISMATCH = "FROZEN_WINDOW_MISMATCH" as const;
export const RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED =
  "CANONICAL_STATE_QUERY_REQUIRED" as const;
export const RESEARCH_REASON_STATE_QUERY_MISMATCH = "STATE_QUERY_MISMATCH" as const;
export const RESEARCH_REASON_ISSUE_STATE_NOT_READY = "ISSUE_STATE_NOT_READY" as const;
export const RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH =
  "AUTHORIZATION_SOURCE_MISMATCH" as const;
export const RESEARCH_REASON_AUTHORIZATION_SOURCE_UNAVAILABLE =
  "AUTHORIZATION_SOURCE_UNAVAILABLE" as const;
export const RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED =
  "AUTOMATION_ACTION_NOT_ALLOWED" as const;
export const RESEARCH_REASON_MAX_FANOUT_EXCEEDED = "MAX_FANOUT_EXCEEDED" as const;
export const RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING =
  "TRUTH_BUDGET_LANE_PREREQUISITE_MISSING" as const;

export type ResearchAutomationActionKind =
  | "manual_research"
  | "autoresearch"
  | "research_automation"
  | "fanout"
  | "continuation"
  | "finalization"
  | "project_initiation"
  | "authorization_sensitive_spawn"
  | "fork_resume_worker";

export type ResearchAutomationDecisionValue =
  | typeof RESEARCH_AUTOMATION_DECISION_FIRED
  | typeof RESEARCH_AUTOMATION_DECISION_SUPPRESSED;

export type ResearchAutomationReasonCode =
  | typeof ACTIVE_TASK_CONTRACT_MISSING_VERDICT
  | typeof ACTIVE_TASK_EVIDENCE_UNVERIFIED_VERDICT
  | typeof ACTIVE_TASK_PRIORITY_CONFLICT
  | typeof RESEARCH_REASON_AUTOMATION_ALLOWED
  | typeof RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED
  | typeof RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT
  | typeof RESEARCH_REASON_FROZEN_WINDOW_MISSING
  | typeof RESEARCH_REASON_FROZEN_WINDOW_MISMATCH
  | typeof RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED
  | typeof RESEARCH_REASON_STATE_QUERY_MISMATCH
  | typeof RESEARCH_REASON_ISSUE_STATE_NOT_READY
  | typeof RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH
  | typeof RESEARCH_REASON_AUTHORIZATION_SOURCE_UNAVAILABLE
  | typeof RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED
  | typeof RESEARCH_REASON_MAX_FANOUT_EXCEEDED
  | typeof RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING
  | typeof STATE_DERIVED_STALE;

export type ResearchFrozenAuthorizationWindow = {
  contractId: string;
  sessionId?: string;
  createdFromUserTurnId: string;
  authorizedRootIssue: string;
  authorizationSourceHash: string;
  allowedAutomationActions: string[];
  maxFanout: number;
  createdAt: string;
  expiresAt?: string;
  runId?: string;
  sha256?: string;
};

export type ResearchAutomationSpawnLineage = {
  requesterSessionId?: string;
  requesterSessionKey?: string;
  childSessionId?: string;
  childSessionKey?: string;
  runId?: string;
  parentRunId?: string;
  contextMode?: string;
  resumeMode?: string;
  childProcessOnly?: boolean;
};

export type ResearchAutomationDecisionRecord = {
  decisionId: string;
  actionKind: ResearchAutomationActionKind;
  decision: ResearchAutomationDecisionValue;
  reasonCode: ResearchAutomationReasonCode;
  activeTaskContractId?: string;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindowHash?: string;
  orchestratorStateHash?: string;
  issueStateHash?: string;
  authSourceHash?: string;
  blockedByConflict: boolean;
  spawnLineage: ResearchAutomationSpawnLineage;
  createdAt: string;
};

export type ResearchAutomationGateResult = {
  allowed: boolean;
  decision: ResearchAutomationDecisionRecord;
  reasons: ResearchAutomationReasonCode[];
};

export type ResearchAuthorizationEvidence = {
  kind:
    | "compaction_summary"
    | "active_memory_hint"
    | "project_initiation_artifact"
    | "research_automation_decision"
    | "historical_checkpoint"
    | "frozen_window";
  path?: string;
  sha256?: string;
  label?: string;
};

type TruthBudgetLanePrerequisites = {
  truthReady?: boolean;
  budgetReady?: boolean;
  laneIsolated?: boolean;
};

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashFrozenWindow(
  window: ResearchFrozenAuthorizationWindow | undefined,
): string | undefined {
  if (!window) {
    return undefined;
  }
  return trimString(window.sha256) ?? sha256(stableStringify({ ...window, sha256: undefined }));
}

function actionAliases(actionKind: ResearchAutomationActionKind): string[] {
  const aliases = [actionKind, `research:${actionKind}`];
  if (actionKind === "fanout") {
    aliases.push("research_fanout", "orchestrated_research", "subagent_fanout");
  }
  if (actionKind === "autoresearch" || actionKind === "research_automation") {
    aliases.push("auto_research", "autoresearch", "research_automation");
  }
  if (actionKind === "manual_research") {
    aliases.push("bounded_manual_research", "manual_research");
  }
  if (actionKind === "authorization_sensitive_spawn" || actionKind === "fork_resume_worker") {
    aliases.push("authorization_sensitive_spawn", "fork_resume_worker", "resume_worker");
  }
  return aliases;
}

function automationActionAllowed(
  contract: ActiveTaskContract,
  actionKind: ResearchAutomationActionKind,
): boolean {
  const allowedActions = contract.allowedAutomationActions ?? [];
  if (allowedActions.includes("*") || allowedActions.includes("research:*")) {
    return true;
  }
  const aliases = actionAliases(actionKind);
  return allowedActions.some((action) => aliases.includes(action));
}

function needsFrozenWindowAndState(actionKind: ResearchAutomationActionKind): boolean {
  return actionKind !== "manual_research";
}

function isIssueReadyForAutomation(statusKey: string | undefined): boolean {
  return Boolean(statusKey && ["ready", "open", "pending", "in-progress"].includes(statusKey));
}

function authorizationSourceHashFromParams(params: {
  authorizationSourceContent?: string | Buffer;
  authorizationSourcePath?: string;
  verifyAuthorizationSourceFile?: boolean;
}): { status: "ok"; hash: string } | { status: "missing" } {
  if (params.authorizationSourceContent != null) {
    return { status: "ok", hash: sha256(params.authorizationSourceContent) };
  }
  if (!params.verifyAuthorizationSourceFile) {
    return { status: "missing" };
  }
  const path = params.authorizationSourcePath?.trim();
  if (!path) {
    return { status: "missing" };
  }
  try {
    return { status: "ok", hash: sha256(fs.readFileSync(path)) };
  } catch {
    return { status: "missing" };
  }
}

function makeDecision(params: {
  actionKind: ResearchAutomationActionKind;
  decision: ResearchAutomationDecisionValue;
  reasonCode: ResearchAutomationReasonCode;
  activeTaskContractId?: string;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindowHash?: string;
  orchestratorStateHash?: string;
  issueStateHash?: string;
  authSourceHash?: string;
  blockedByConflict?: boolean;
  spawnLineage?: ResearchAutomationSpawnLineage;
  nowMs?: number;
  decisionId?: string;
}): ResearchAutomationDecisionRecord {
  const createdAt = new Date(
    Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now(),
  ).toISOString();
  return {
    decisionId: params.decisionId ?? randomUUID(),
    actionKind: params.actionKind,
    decision: params.decision,
    reasonCode: params.reasonCode,
    ...(params.activeTaskContractId ? { activeTaskContractId: params.activeTaskContractId } : {}),
    ...(params.latestUserTurnId ? { latestUserTurnId: params.latestUserTurnId } : {}),
    ...(params.authorizedRootIssue ? { authorizedRootIssue: params.authorizedRootIssue } : {}),
    ...(params.frozenWindowHash ? { frozenWindowHash: params.frozenWindowHash } : {}),
    ...(params.orchestratorStateHash
      ? { orchestratorStateHash: params.orchestratorStateHash }
      : {}),
    ...(params.issueStateHash ? { issueStateHash: params.issueStateHash } : {}),
    ...(params.authSourceHash ? { authSourceHash: params.authSourceHash } : {}),
    blockedByConflict: params.blockedByConflict === true,
    spawnLineage: params.spawnLineage ?? {},
    createdAt,
  };
}

function fail(params: {
  actionKind: ResearchAutomationActionKind;
  reasonCode: ResearchAutomationReasonCode;
  reasons?: ResearchAutomationReasonCode[];
  activeTaskContractId?: string;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindowHash?: string;
  stateQuery?: CanonicalOrchestratorStateQuery;
  authSourceHash?: string;
  blockedByConflict?: boolean;
  spawnLineage?: ResearchAutomationSpawnLineage;
  nowMs?: number;
}): ResearchAutomationGateResult {
  return {
    allowed: false,
    reasons: params.reasons ?? [params.reasonCode],
    decision: makeDecision({
      actionKind: params.actionKind,
      decision: RESEARCH_AUTOMATION_DECISION_SUPPRESSED,
      reasonCode: params.reasonCode,
      activeTaskContractId: params.activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue: params.authorizedRootIssue,
      frozenWindowHash: params.frozenWindowHash,
      orchestratorStateHash: params.stateQuery?.orchestrator?.sha256,
      issueStateHash: params.stateQuery?.issueStateHash,
      authSourceHash: params.authSourceHash,
      blockedByConflict: params.blockedByConflict,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    }),
  };
}

function fired(params: {
  actionKind: ResearchAutomationActionKind;
  reasonCode: ResearchAutomationReasonCode;
  activeTaskContractId: string;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindowHash?: string;
  stateQuery?: CanonicalOrchestratorStateQuery;
  authSourceHash?: string;
  spawnLineage?: ResearchAutomationSpawnLineage;
  nowMs?: number;
}): ResearchAutomationGateResult {
  return {
    allowed: true,
    reasons: [params.reasonCode],
    decision: makeDecision({
      actionKind: params.actionKind,
      decision: RESEARCH_AUTOMATION_DECISION_FIRED,
      reasonCode: params.reasonCode,
      activeTaskContractId: params.activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue: params.authorizedRootIssue,
      frozenWindowHash: params.frozenWindowHash,
      orchestratorStateHash: params.stateQuery?.orchestrator?.sha256,
      issueStateHash: params.stateQuery?.issueStateHash,
      authSourceHash: params.authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    }),
  };
}

function hasFreshCurrentTurnAuthorization(params: {
  contract: ActiveTaskContract;
  latestUserTurnId?: string;
}): boolean {
  const latest = trimString(params.latestUserTurnId);
  const createdFrom = trimString(params.contract.createdFromUserTurnId);
  return Boolean(latest && createdFrom && latest === createdFrom);
}

function frozenWindowMatches(params: {
  window: ResearchFrozenAuthorizationWindow;
  contract: ActiveTaskContract;
  activeTaskContractId: string;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  actionKind: ResearchAutomationActionKind;
  nowMs?: number;
}): boolean {
  if (params.window.contractId !== params.activeTaskContractId) {
    return false;
  }
  if (params.contract.sessionId && params.window.sessionId !== params.contract.sessionId) {
    return false;
  }
  if (params.contract.runId && params.window.runId !== params.contract.runId) {
    return false;
  }
  if (params.contract.expiresAt && params.window.expiresAt !== params.contract.expiresAt) {
    return false;
  }
  if (!params.window.expiresAt && !params.window.runId) {
    return false;
  }
  if (params.window.expiresAt) {
    const expiresAt = Date.parse(params.window.expiresAt);
    const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      return false;
    }
  }
  if (params.window.createdFromUserTurnId !== params.contract.createdFromUserTurnId) {
    return false;
  }
  if (params.latestUserTurnId && params.window.createdFromUserTurnId !== params.latestUserTurnId) {
    return false;
  }
  const root = params.authorizedRootIssue ?? params.contract.authorizedRootIssue;
  if (!root || params.window.authorizedRootIssue !== root) {
    return false;
  }
  if (params.window.authorizationSourceHash !== params.contract.authorizationSourceHash) {
    return false;
  }
  if (params.window.maxFanout !== params.contract.maxFanout) {
    return false;
  }
  return actionAliases(params.actionKind).some((action) =>
    params.window.allowedAutomationActions.includes(action),
  );
}

function stateQueryMatches(params: {
  stateQuery: CanonicalOrchestratorStateQuery;
  contract: ActiveTaskContract;
  activeTaskContractId: string;
  authorizedRootIssue?: string;
}): ResearchAutomationReasonCode | undefined {
  const { stateQuery, contract, activeTaskContractId } = params;
  if (stateQuery.helperId !== CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID) {
    return RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED;
  }
  if (stateQuery.derivedStateStale || stateQuery.derivedState?.reasonCode === STATE_DERIVED_STALE) {
    return STATE_DERIVED_STALE;
  }
  if (stateQuery.staleByAge) {
    return STATE_DERIVED_STALE;
  }
  if (!stateQuery.ok || !stateQuery.orchestrator || !stateQuery.selectedIssue) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  const root = params.authorizedRootIssue ?? contract.authorizedRootIssue;
  const selectedIssueMatchesRoot = Boolean(
    root &&
    [
      stateQuery.selectedIssue.id,
      stateQuery.selectedIssue.rootIssue,
      stateQuery.selectedIssue.authorizedRootIssue,
    ].includes(root),
  );
  if (!root || !selectedIssueMatchesRoot || stateQuery.orchestrator.authorizedRootIssue !== root) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  const issueContractId = stateQuery.selectedIssue.activeTaskContractId;
  const orchestratorContractId = stateQuery.orchestrator.activeTaskContractId;
  if (issueContractId !== activeTaskContractId || orchestratorContractId !== activeTaskContractId) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  if (
    stateQuery.selectedIssue.authorizationSourceHash !== contract.authorizationSourceHash ||
    stateQuery.orchestrator.authorizationSourceHash !== contract.authorizationSourceHash
  ) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  if (!isIssueReadyForAutomation(stateQuery.selectedIssue.status.key)) {
    return RESEARCH_REASON_ISSUE_STATE_NOT_READY;
  }
  if (!isIssueReadyForAutomation(stateQuery.orchestrator.phase.key)) {
    return RESEARCH_REASON_ISSUE_STATE_NOT_READY;
  }
  return undefined;
}

function truthBudgetLaneReady(prerequisites: TruthBudgetLanePrerequisites | undefined): boolean {
  return (
    prerequisites?.truthReady === true &&
    prerequisites.budgetReady === true &&
    prerequisites.laneIsolated === true
  );
}

export function evaluateResearchAutomationAuthorization(params: {
  actionKind: ResearchAutomationActionKind;
  activeTaskContract?: unknown;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindow?: ResearchFrozenAuthorizationWindow;
  stateQuery?: CanonicalOrchestratorStateQuery;
  backgroundHints?: ActiveTaskPriorityHint[];
  truthBudgetLane?: TruthBudgetLanePrerequisites;
  fanoutCount?: number;
  authorizationSourceContent?: string | Buffer;
  verifyAuthorizationSourceFile?: boolean;
  candidateAuthorizationEvidence?: ResearchAuthorizationEvidence[];
  priorDecision?: ResearchAutomationDecisionRecord;
  spawnLineage?: ResearchAutomationSpawnLineage;
  nowMs?: number;
}): ResearchAutomationGateResult {
  const actionKind = params.actionKind;
  const frozenWindowHash = hashFrozenWindow(params.frozenWindow);
  const activeContract = validateActiveTaskContractForAcceptance({
    activeTaskContract: params.activeTaskContract,
    nowMs: params.nowMs,
  });
  if (!activeContract.ok) {
    const reasonCode =
      activeContract.contractVerdict === ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        ? ACTIVE_TASK_CONTRACT_MISSING_VERDICT
        : RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT;
    return fail({
      actionKind,
      reasonCode,
      activeTaskContractId: activeContract.activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      blockedByConflict: false,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  const { contract } = activeContract;
  const activeTaskContractId = activeContract.activeTaskContractId;
  const authorizedRootIssue = params.authorizedRootIssue ?? contract.authorizedRootIssue;
  const sourceHash = authorizationSourceHashFromParams({
    authorizationSourceContent: params.authorizationSourceContent,
    authorizationSourcePath: contract.authorizationSourcePath,
    verifyAuthorizationSourceFile: params.verifyAuthorizationSourceFile === true,
  });
  const authSourceHash =
    sourceHash.status === "ok" ? sourceHash.hash : trimString(contract.authorizationSourceHash);

  if (!hasFreshCurrentTurnAuthorization({ contract, latestUserTurnId: params.latestUserTurnId })) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  const priority = resolveActiveTaskCurrentRequest({
    activeTaskContract: contract,
    backgroundHints: params.backgroundHints,
  });
  if (priority.ok && priority.taskPriorityConflicts.length > 0) {
    return fail({
      actionKind,
      reasonCode: ACTIVE_TASK_PRIORITY_CONFLICT,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      blockedByConflict: true,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (!automationActionAllowed(contract, actionKind)) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (sourceHash.status === "missing" && params.verifyAuthorizationSourceFile === true) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_AUTHORIZATION_SOURCE_UNAVAILABLE,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }
  if (sourceHash.status === "ok" && sourceHash.hash !== contract.authorizationSourceHash) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash: sourceHash.hash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (!needsFrozenWindowAndState(actionKind)) {
    return fired({
      actionKind,
      reasonCode: RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (!params.frozenWindow) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_FROZEN_WINDOW_MISSING,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }
  if (
    !frozenWindowMatches({
      window: params.frozenWindow,
      contract,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      actionKind,
      nowMs: params.nowMs,
    })
  ) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_FROZEN_WINDOW_MISMATCH,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (
    !params.stateQuery ||
    params.stateQuery.helperId !== CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID
  ) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }
  const stateFailure = stateQueryMatches({
    stateQuery: params.stateQuery,
    contract,
    activeTaskContractId,
    authorizedRootIssue,
  });
  if (stateFailure) {
    return fail({
      actionKind,
      reasonCode: stateFailure,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  const fanoutCount = Number.isFinite(params.fanoutCount) ? Number(params.fanoutCount) : 1;
  if (
    actionKind === "fanout" &&
    (!Number.isInteger(fanoutCount) || fanoutCount < 1 || fanoutCount > (contract.maxFanout ?? 0))
  ) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_MAX_FANOUT_EXCEEDED,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  if (!truthBudgetLaneReady(params.truthBudgetLane)) {
    return fail({
      actionKind,
      reasonCode: RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING,
      activeTaskContractId,
      latestUserTurnId: params.latestUserTurnId,
      authorizedRootIssue,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    });
  }

  return fired({
    actionKind,
    reasonCode: RESEARCH_REASON_AUTOMATION_ALLOWED,
    activeTaskContractId,
    latestUserTurnId: params.latestUserTurnId,
    authorizedRootIssue,
    frozenWindowHash,
    stateQuery: params.stateQuery,
    authSourceHash,
    spawnLineage: params.spawnLineage,
    nowMs: params.nowMs,
  });
}
