import {
  advanceCommonWorkRevision,
  CommonWorkAuthorityError,
  CommonWorkConflictError,
  type CommonWorkRecord,
} from "./common-work.js";

export type CommonWorkDiscoveryClassification =
  | "prerequisite_blocker"
  | "separate_follow_up"
  | "irrelevant";
export type CommonWorkDiscovery = {
  discoveryId: string;
  objective: string;
  classification: CommonWorkDiscoveryClassification;
  rationale: string;
  approvalReceipt?: string;
};

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CommonWorkConflictError(name + " must not be empty");
  }
  return normalized;
}

function requireNonEmptyList(values: readonly string[], name: string): string[] {
  if (values.length === 0) {
    throw new CommonWorkConflictError(name + " must not be empty");
  }
  return values.map((value) => requireNonEmpty(value, name));
}

export function reviseCommonWorkGoal(
  record: CommonWorkRecord,
  correction: {
    goal: string;
    objectiveDigest: string;
    scope: string[];
    acceptanceCriteria: string[];
    reportingLeadAgentId: string;
    source: "user_correction" | "agent_discovery" | "separate_goal";
    correctionReceipt?: string;
  },
  now: number,
): CommonWorkRecord {
  if (correction.source === "separate_goal") {
    throw new CommonWorkConflictError("a separate goal requires a separate work id");
  }
  if (correction.source !== "user_correction" || !correction.correctionReceipt?.trim()) {
    throw new CommonWorkAuthorityError(
      "only a receipt-backed user correction may revise admitted objective facts",
    );
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      goal: requireNonEmpty(correction.goal, "objective"),
      objectiveDigest: requireNonEmpty(correction.objectiveDigest, "objective digest"),
      scope: requireNonEmptyList(correction.scope, "scope"),
      acceptanceCriteria: requireNonEmptyList(correction.acceptanceCriteria, "acceptance criteria"),
      reportingLeadAgentId: requireNonEmpty(
        correction.reportingLeadAgentId,
        "reporting lead agent id",
      ),
      scopeRevision: record.scopeRevision + 1,
    },
    now,
  );
}

export function classifyCommonWorkDiscovery(
  record: CommonWorkRecord,
  input: Omit<CommonWorkDiscovery, "approvalReceipt">,
  now: number,
): CommonWorkRecord {
  requireNonEmpty(input.discoveryId, "discovery id");
  requireNonEmpty(input.objective, "discovered objective");
  requireNonEmpty(input.rationale, "discovery rationale");
  const existing = record.discoveries.find((item) => item.discoveryId === input.discoveryId);
  if (existing) {
    if (
      existing.objective !== input.objective ||
      existing.classification !== input.classification ||
      existing.rationale !== input.rationale
    ) {
      throw new CommonWorkConflictError("discovery was replayed with conflicting facts");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    { ...record, discoveries: [...record.discoveries, { ...input }] },
    now,
  );
}

export function approveCommonWorkDiscovery(
  record: CommonWorkRecord,
  input: { discoveryId: string; approvalReceipt: string },
  now: number,
): CommonWorkRecord {
  const approvalReceipt = requireNonEmpty(input.approvalReceipt, "discovery approval receipt");
  const index = record.discoveries.findIndex((item) => item.discoveryId === input.discoveryId);
  if (index < 0) {
    throw new CommonWorkConflictError("discovery must be classified before approval");
  }
  const discovery = record.discoveries[index]!;
  if (discovery.classification === "irrelevant") {
    throw new CommonWorkConflictError("irrelevant discovery cannot consume work resources");
  }
  if (discovery.approvalReceipt) {
    if (discovery.approvalReceipt !== approvalReceipt) {
      throw new CommonWorkConflictError("discovery approval receipt cannot be replaced");
    }
    return record;
  }
  const discoveries = [...record.discoveries];
  discoveries[index] = { ...discovery, approvalReceipt };
  return advanceCommonWorkRevision({ ...record, discoveries }, now);
}

export function assertCommonWorkDiscoveryAllocation(
  record: CommonWorkRecord,
  discoveryId: string,
): void {
  const discovery = record.discoveries.find((item) => item.discoveryId === discoveryId);
  if (!discovery?.approvalReceipt) {
    throw new CommonWorkAuthorityError(
      "discovered objective cannot open execution, route, worker, or resources without approval",
    );
  }
}

export function commonWorkReportingDisposition(
  record: CommonWorkRecord,
  input: {
    agentId: string;
    directlyUserRequested: boolean;
    assignment: "lead" | "helper" | "specialist";
    messageKind: "ack" | "progress" | "terminal";
  },
): "report_normally" | "return_once_to_lead" | "suppress_user_flow" {
  if (input.assignment === "lead" && input.agentId !== record.reportingLeadAgentId) {
    throw new CommonWorkAuthorityError("reporting lead assignment does not match admitted lead");
  }
  if (input.agentId === record.reportingLeadAgentId || input.directlyUserRequested) {
    return "report_normally";
  }
  return input.messageKind === "terminal" ? "return_once_to_lead" : "suppress_user_flow";
}

export function recordCommonWorkHelperReturn(
  record: CommonWorkRecord,
  input: { helperAgentId: string; targetAgentId: string; receipt: string },
  now: number,
): CommonWorkRecord {
  if (input.targetAgentId !== record.reportingLeadAgentId) {
    throw new CommonWorkAuthorityError("helper return must target the admitted reporting lead");
  }
  if (input.helperAgentId === record.reportingLeadAgentId) {
    throw new CommonWorkConflictError("reporting lead does not use the helper return path");
  }
  const receipt = requireNonEmpty(input.receipt, "helper return receipt");
  const existing = record.helperReturns.find((item) => item.agentId === input.helperAgentId);
  if (existing) {
    if (existing.receipt !== receipt) {
      throw new CommonWorkConflictError("helper already returned a different terminal result");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      helperReturns: [...record.helperReturns, { agentId: input.helperAgentId, receipt }],
    },
    now,
  );
}

export function assertCommonWorkInteractionTerminal(input: {
  kind: "execution" | "review" | "discussion";
  objective: string;
  terminalOutput?: { decision?: string; conclusion?: string; nextAction?: string };
}): void {
  requireNonEmpty(input.objective, "interaction objective");
  if (input.kind === "execution") {
    return;
  }
  const output = input.terminalOutput;
  if (
    !output ||
    ![output.decision, output.conclusion, output.nextAction].some((value) => value?.trim())
  ) {
    throw new CommonWorkConflictError(
      "review or discussion requires a terminal decision, conclusion, or next action",
    );
  }
}
