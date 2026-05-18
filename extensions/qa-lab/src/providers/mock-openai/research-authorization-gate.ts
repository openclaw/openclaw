import { createHash, randomUUID } from "node:crypto";

const CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID = "canonical-orchestrator-state-query" as const;
const STATE_DERIVED_STALE = "STATE_DERIVED_STALE" as const;
const TASK_CONTRACT_MISSING = "TASK_CONTRACT_MISSING" as const;
const TASK_PRIORITY_CONFLICT = "TASK_PRIORITY_CONFLICT" as const;
const RESEARCH_REASON_AUTOMATION_ALLOWED = "AUTOMATION_ALLOWED" as const;
const RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED = "MANUAL_RESEARCH_ALLOWED" as const;
const RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT = "STALE_AUTHORIZATION_CONTRACT" as const;
const RESEARCH_REASON_FROZEN_WINDOW_MISSING = "FROZEN_WINDOW_MISSING" as const;
const RESEARCH_REASON_FROZEN_WINDOW_MISMATCH = "FROZEN_WINDOW_MISMATCH" as const;
const RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED = "CANONICAL_STATE_QUERY_REQUIRED" as const;
const RESEARCH_REASON_STATE_QUERY_MISMATCH = "STATE_QUERY_MISMATCH" as const;
const RESEARCH_REASON_ISSUE_STATE_NOT_READY = "ISSUE_STATE_NOT_READY" as const;
const RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH = "AUTHORIZATION_SOURCE_MISMATCH" as const;
const RESEARCH_REASON_AUTHORIZATION_SOURCE_UNAVAILABLE =
  "AUTHORIZATION_SOURCE_UNAVAILABLE" as const;
const RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED = "AUTOMATION_ACTION_NOT_ALLOWED" as const;
const RESEARCH_REASON_MAX_FANOUT_EXCEEDED = "MAX_FANOUT_EXCEEDED" as const;
const RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING =
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

type ResearchAutomationDecisionValue = "FIRED" | "SUPPRESSED";
type ResearchAutomationReasonCode =
  | typeof TASK_CONTRACT_MISSING
  | typeof TASK_PRIORITY_CONFLICT
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

type ResearchAutomationDecisionRecord = {
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
  spawnLineage: Record<string, unknown>;
  createdAt: string;
};

export type ResearchAutomationGateResult = {
  allowed: boolean;
  decision: ResearchAutomationDecisionRecord;
  reasons: ResearchAutomationReasonCode[];
};

type MockActiveTaskContract = {
  contractId: string;
  taskId: string;
  sessionId: string;
  createdFromUserTurnId: string;
  createdAt: string;
  expiresAt?: string;
  runId?: string;
  authorizationSourcePath: string;
  authorizationSourceHash: string;
  authorizedRootIssue: string;
  allowedAutomationActions: string[];
  maxFanout: number;
  staleContextConflictPolicy: string;
  currentUserRequest: string;
};

type FrozenWindow = {
  contractId?: unknown;
  sessionId?: unknown;
  createdFromUserTurnId?: unknown;
  authorizedRootIssue?: unknown;
  authorizationSourceHash?: unknown;
  allowedAutomationActions?: unknown;
  maxFanout?: unknown;
  expiresAt?: unknown;
  runId?: unknown;
  sha256?: unknown;
};

type CanonicalStateQueryLike = {
  helperId?: unknown;
  ok?: unknown;
  staleByAge?: unknown;
  derivedStateStale?: unknown;
  derivedState?: { reasonCode?: unknown };
  orchestrator?: {
    sha256?: unknown;
    phase?: { key?: unknown };
    activeTaskContractId?: unknown;
    authorizedRootIssue?: unknown;
    authorizationSourceHash?: unknown;
  };
  selectedIssue?: {
    id?: unknown;
    rootIssue?: unknown;
    authorizedRootIssue?: unknown;
    status?: { key?: unknown };
    activeTaskContractId?: unknown;
    authorizationSourceHash?: unknown;
  };
  issueStateHash?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string): string {
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

function hashFrozenWindow(window: FrozenWindow | undefined): string | undefined {
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

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .map((entry) => trimString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return result.length === value.length ? result : undefined;
}

function readContract(value: unknown, nowMs: number): MockActiveTaskContract | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contractId = trimString(value.contractId);
  const taskId = trimString(value.taskId);
  const sessionId = trimString(value.sessionId);
  const createdFromUserTurnId = trimString(value.createdFromUserTurnId);
  const createdAt = trimString(value.createdAt);
  const expiresAt = trimString(value.expiresAt);
  const runId = trimString(value.runId);
  const authorizationSourcePath = trimString(value.authorizationSourcePath);
  const authorizationSourceHash = trimString(value.authorizationSourceHash);
  const authorizedRootIssue = trimString(value.authorizedRootIssue);
  const allowedAutomationActions = readStringArray(value.allowedAutomationActions);
  const currentUserRequest = trimString(value.currentUserRequest);
  const staleContextConflictPolicy = trimString(value.staleContextConflictPolicy);
  const maxFanout =
    typeof value.maxFanout === "number" && Number.isFinite(value.maxFanout)
      ? Math.floor(value.maxFanout)
      : undefined;
  if (
    !contractId ||
    !taskId ||
    !sessionId ||
    !createdFromUserTurnId ||
    !createdAt ||
    (!expiresAt && !runId) ||
    !authorizationSourcePath ||
    !authorizationSourceHash ||
    !authorizedRootIssue ||
    !allowedAutomationActions ||
    maxFanout === undefined ||
    !currentUserRequest ||
    !staleContextConflictPolicy
  ) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    return undefined;
  }
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      return undefined;
    }
  }
  return {
    contractId,
    taskId,
    sessionId,
    createdFromUserTurnId,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(runId ? { runId } : {}),
    authorizationSourcePath,
    authorizationSourceHash,
    authorizedRootIssue,
    allowedAutomationActions,
    maxFanout,
    staleContextConflictPolicy,
    currentUserRequest,
  };
}

function makeDecision(params: {
  actionKind: ResearchAutomationActionKind;
  decision: ResearchAutomationDecisionValue;
  reasonCode: ResearchAutomationReasonCode;
  contract?: MockActiveTaskContract;
  latestUserTurnId?: string;
  frozenWindowHash?: string;
  stateQuery?: CanonicalStateQueryLike;
  authSourceHash?: string;
  blockedByConflict?: boolean;
  spawnLineage?: Record<string, unknown>;
  nowMs: number;
}): ResearchAutomationDecisionRecord {
  return {
    decisionId: randomUUID(),
    actionKind: params.actionKind,
    decision: params.decision,
    reasonCode: params.reasonCode,
    ...(params.contract ? { activeTaskContractId: params.contract.contractId } : {}),
    ...(params.latestUserTurnId ? { latestUserTurnId: params.latestUserTurnId } : {}),
    ...(params.contract ? { authorizedRootIssue: params.contract.authorizedRootIssue } : {}),
    ...(params.frozenWindowHash ? { frozenWindowHash: params.frozenWindowHash } : {}),
    ...(trimString(params.stateQuery?.orchestrator?.sha256)
      ? { orchestratorStateHash: trimString(params.stateQuery?.orchestrator?.sha256) }
      : {}),
    ...(trimString(params.stateQuery?.issueStateHash)
      ? { issueStateHash: trimString(params.stateQuery?.issueStateHash) }
      : {}),
    ...(params.authSourceHash ? { authSourceHash: params.authSourceHash } : {}),
    blockedByConflict: params.blockedByConflict === true,
    spawnLineage: params.spawnLineage ?? {},
    createdAt: new Date(params.nowMs).toISOString(),
  };
}

function gateResult(params: {
  allowed: boolean;
  actionKind: ResearchAutomationActionKind;
  reasonCode: ResearchAutomationReasonCode;
  contract?: MockActiveTaskContract;
  latestUserTurnId?: string;
  frozenWindowHash?: string;
  stateQuery?: CanonicalStateQueryLike;
  authSourceHash?: string;
  blockedByConflict?: boolean;
  spawnLineage?: Record<string, unknown>;
  nowMs: number;
}): ResearchAutomationGateResult {
  return {
    allowed: params.allowed,
    reasons: [params.reasonCode],
    decision: makeDecision({
      actionKind: params.actionKind,
      decision: params.allowed ? "FIRED" : "SUPPRESSED",
      reasonCode: params.reasonCode,
      contract: params.contract,
      latestUserTurnId: params.latestUserTurnId,
      frozenWindowHash: params.frozenWindowHash,
      stateQuery: params.stateQuery,
      authSourceHash: params.authSourceHash,
      blockedByConflict: params.blockedByConflict,
      spawnLineage: params.spawnLineage,
      nowMs: params.nowMs,
    }),
  };
}

function actionAllowed(
  contract: MockActiveTaskContract,
  actionKind: ResearchAutomationActionKind,
): boolean {
  if (
    contract.allowedAutomationActions.includes("*") ||
    contract.allowedAutomationActions.includes("research:*")
  ) {
    return true;
  }
  const aliases = actionAliases(actionKind);
  return contract.allowedAutomationActions.some((action) => aliases.includes(action));
}

function frozenWindowMatches(params: {
  window: FrozenWindow;
  contract: MockActiveTaskContract;
  latestUserTurnId?: string;
  actionKind: ResearchAutomationActionKind;
  nowMs: number;
}): boolean {
  const allowedAutomationActions = readStringArray(params.window.allowedAutomationActions);
  const maxFanout =
    typeof params.window.maxFanout === "number" ? Math.floor(params.window.maxFanout) : undefined;
  const expiresAt = trimString(params.window.expiresAt);
  if (trimString(params.window.contractId) !== params.contract.contractId) {
    return false;
  }
  if (trimString(params.window.sessionId) !== params.contract.sessionId) {
    return false;
  }
  if (params.contract.runId && trimString(params.window.runId) !== params.contract.runId) {
    return false;
  }
  if (params.contract.expiresAt && expiresAt !== params.contract.expiresAt) {
    return false;
  }
  if (!expiresAt && !trimString(params.window.runId)) {
    return false;
  }
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= params.nowMs) {
      return false;
    }
  }
  if (trimString(params.window.createdFromUserTurnId) !== params.contract.createdFromUserTurnId) {
    return false;
  }
  if (
    params.latestUserTurnId &&
    trimString(params.window.createdFromUserTurnId) !== params.latestUserTurnId
  ) {
    return false;
  }
  if (trimString(params.window.authorizedRootIssue) !== params.contract.authorizedRootIssue) {
    return false;
  }
  if (
    trimString(params.window.authorizationSourceHash) !== params.contract.authorizationSourceHash
  ) {
    return false;
  }
  if (maxFanout !== params.contract.maxFanout || !allowedAutomationActions) {
    return false;
  }
  return actionAliases(params.actionKind).some((action) =>
    allowedAutomationActions.includes(action),
  );
}

function isIssueReady(statusKey: unknown): boolean {
  return (
    typeof statusKey === "string" && ["ready", "open", "pending", "in-progress"].includes(statusKey)
  );
}

function stateQueryFailure(
  stateQuery: CanonicalStateQueryLike | undefined,
  contract: MockActiveTaskContract,
): ResearchAutomationReasonCode | undefined {
  if (!stateQuery || stateQuery.helperId !== CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID) {
    return RESEARCH_REASON_CANONICAL_STATE_QUERY_REQUIRED;
  }
  if (
    stateQuery.derivedStateStale === true ||
    stateQuery.staleByAge === true ||
    stateQuery.derivedState?.reasonCode === STATE_DERIVED_STALE
  ) {
    return STATE_DERIVED_STALE;
  }
  const orchestrator = stateQuery.orchestrator;
  const issue = stateQuery.selectedIssue;
  if (stateQuery.ok !== true || !orchestrator || !issue) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  const root = contract.authorizedRootIssue;
  const issueMatchesRoot = [issue.id, issue.rootIssue, issue.authorizedRootIssue].includes(root);
  if (!issueMatchesRoot || orchestrator.authorizedRootIssue !== root) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  if (
    issue.activeTaskContractId !== contract.contractId ||
    orchestrator.activeTaskContractId !== contract.contractId
  ) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  if (
    issue.authorizationSourceHash !== contract.authorizationSourceHash ||
    orchestrator.authorizationSourceHash !== contract.authorizationSourceHash
  ) {
    return RESEARCH_REASON_STATE_QUERY_MISMATCH;
  }
  if (!isIssueReady(issue.status?.key) || !isIssueReady(orchestrator.phase?.key)) {
    return RESEARCH_REASON_ISSUE_STATE_NOT_READY;
  }
  return undefined;
}

function hasPriorityConflict(contract: MockActiveTaskContract, backgroundHints: unknown): boolean {
  if (!Array.isArray(backgroundHints)) {
    return false;
  }
  return backgroundHints.some((hint) => {
    if (!isRecord(hint)) {
      return false;
    }
    const taskId = trimString(hint.taskId);
    const request = trimString(hint.currentUserRequest);
    const contractId = trimString(hint.activeTaskContractId);
    return Boolean(
      (taskId && taskId !== contract.taskId) ||
      (request && request !== contract.currentUserRequest) ||
      (contractId && contractId !== contract.contractId),
    );
  });
}

export function evaluateResearchAutomationAuthorization(params: {
  actionKind: ResearchAutomationActionKind;
  activeTaskContract?: unknown;
  latestUserTurnId?: string;
  authorizedRootIssue?: string;
  frozenWindow?: FrozenWindow;
  stateQuery?: CanonicalStateQueryLike;
  backgroundHints?: unknown;
  truthBudgetLane?: unknown;
  fanoutCount?: number;
  authorizationSourceContent?: string;
  verifyAuthorizationSourceFile?: boolean;
  priorDecision?: unknown;
  spawnLineage?: Record<string, unknown>;
  nowMs?: number;
}): ResearchAutomationGateResult {
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const frozenWindowHash = hashFrozenWindow(params.frozenWindow);
  const missingContract = params.activeTaskContract == null || params.activeTaskContract === "";
  const contract = readContract(params.activeTaskContract, nowMs);
  if (!contract) {
    return gateResult({
      allowed: false,
      actionKind: params.actionKind,
      reasonCode: missingContract
        ? TASK_CONTRACT_MISSING
        : RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT,
      latestUserTurnId: params.latestUserTurnId,
      frozenWindowHash,
      stateQuery: params.stateQuery,
      spawnLineage: params.spawnLineage,
      nowMs,
    });
  }
  const authSourceHash = params.authorizationSourceContent
    ? sha256(params.authorizationSourceContent)
    : contract.authorizationSourceHash;

  const base = {
    actionKind: params.actionKind,
    contract,
    latestUserTurnId: params.latestUserTurnId,
    frozenWindowHash,
    stateQuery: params.stateQuery,
    authSourceHash,
    spawnLineage: params.spawnLineage,
    nowMs,
  };
  if (params.latestUserTurnId !== contract.createdFromUserTurnId) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT,
    });
  }
  if (params.authorizedRootIssue && params.authorizedRootIssue !== contract.authorizedRootIssue) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_STALE_AUTHORIZATION_CONTRACT,
    });
  }
  if (hasPriorityConflict(contract, params.backgroundHints)) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: TASK_PRIORITY_CONFLICT,
      blockedByConflict: true,
    });
  }
  if (!actionAllowed(contract, params.actionKind)) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_AUTOMATION_ACTION_NOT_ALLOWED,
    });
  }
  if (params.verifyAuthorizationSourceFile === true && !params.authorizationSourceContent) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_AUTHORIZATION_SOURCE_UNAVAILABLE,
    });
  }
  if (params.authorizationSourceContent && authSourceHash !== contract.authorizationSourceHash) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_AUTHORIZATION_SOURCE_MISMATCH,
    });
  }
  if (params.actionKind === "manual_research") {
    return gateResult({
      ...base,
      allowed: true,
      reasonCode: RESEARCH_REASON_MANUAL_RESEARCH_ALLOWED,
    });
  }
  if (!params.frozenWindow) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_FROZEN_WINDOW_MISSING,
    });
  }
  if (
    !frozenWindowMatches({
      window: params.frozenWindow,
      contract,
      latestUserTurnId: params.latestUserTurnId,
      actionKind: params.actionKind,
      nowMs,
    })
  ) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_FROZEN_WINDOW_MISMATCH,
    });
  }
  const stateFailure = stateQueryFailure(params.stateQuery, contract);
  if (stateFailure) {
    return gateResult({ ...base, allowed: false, reasonCode: stateFailure });
  }
  const fanoutCount = Number.isFinite(params.fanoutCount) ? Number(params.fanoutCount) : 1;
  if (
    params.actionKind === "fanout" &&
    (!Number.isInteger(fanoutCount) || fanoutCount < 1 || fanoutCount > contract.maxFanout)
  ) {
    return gateResult({ ...base, allowed: false, reasonCode: RESEARCH_REASON_MAX_FANOUT_EXCEEDED });
  }
  const truthBudgetLane = isRecord(params.truthBudgetLane) ? params.truthBudgetLane : {};
  if (
    truthBudgetLane.truthReady !== true ||
    truthBudgetLane.budgetReady !== true ||
    truthBudgetLane.laneIsolated !== true
  ) {
    return gateResult({
      ...base,
      allowed: false,
      reasonCode: RESEARCH_REASON_TRUTH_BUDGET_LANE_PREREQUISITE_MISSING,
    });
  }
  return gateResult({ ...base, allowed: true, reasonCode: RESEARCH_REASON_AUTOMATION_ALLOWED });
}
