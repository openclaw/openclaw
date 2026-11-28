import {
  admitCommonWork,
  approveCommonWorkDiscovery,
  assertCommonWorkDiscoveryAllocation,
  attachCommonWorkExecution,
  classifyCommonWorkDiscovery,
  CommonWorkConflictError,
  recordCommonWorkCallback,
  recordCommonWorkDelivery,
  recordCommonWorkHelperReturn,
  reviseCommonWorkGoal,
  settleCommonWorkExecution,
  type CommonWorkAdmission,
  type CommonWorkDiscoveryClassification,
  type CommonWorkRecord,
  type CommonWorkRoute,
} from "@openclaw/workboard-contract";

export type CommonWorkOperation =
  | { kind: "admit"; admission: Omit<CommonWorkAdmission, "now"> }
  | {
      kind: "correct";
      expectedRevision: number;
      goal: string;
      objectiveDigest: string;
      scope: string[];
      acceptanceCriteria: string[];
      reportingLeadAgentId: string;
      source: "user_correction" | "agent_discovery" | "separate_goal";
      correctionReceipt?: string;
    }
  | {
      kind: "classify_discovery";
      expectedRevision: number;
      discoveryId: string;
      objective: string;
      classification: CommonWorkDiscoveryClassification;
      rationale: string;
    }
  | {
      kind: "approve_discovery";
      expectedRevision: number;
      discoveryId: string;
      approvalReceipt: string;
    }
  | {
      kind: "helper_return";
      expectedRevision: number;
      helperAgentId: string;
      targetAgentId: string;
      receipt: string;
    }
  | {
      kind: "attach";
      expectedRevision: number;
      executionId: string;
      generation: number;
      sessionKey: string;
      discoveredObjectiveId?: string;
    }
  | {
      kind: "terminal";
      expectedRevision: number;
      executionId: string;
      generation: number;
      status: "done" | "failed" | "cancelled";
      terminalReceipt: string;
    }
  | {
      kind: "callback";
      expectedRevision: number;
      dedupeKey: string;
      receipt: string;
      targetSessionKey: string;
    }
  | { kind: "delivery"; expectedRevision: number; route: CommonWorkRoute; receipt: string };

export function applyCommonWorkOperation(
  existing: CommonWorkRecord | undefined,
  operation: CommonWorkOperation,
  now: number,
): CommonWorkRecord {
  if (operation.kind === "admit") {
    return admitCommonWork({ ...operation.admission, now }, existing).record;
  }
  if (!existing) {
    throw new CommonWorkConflictError("common work must be admitted first");
  }
  if (operation.expectedRevision !== existing.revision) {
    throw new CommonWorkConflictError("stale common-work revision");
  }
  switch (operation.kind) {
    case "correct":
      return reviseCommonWorkGoal(existing, operation, now);
    case "classify_discovery":
      return classifyCommonWorkDiscovery(existing, operation, now);
    case "approve_discovery":
      return approveCommonWorkDiscovery(existing, operation, now);
    case "helper_return":
      return recordCommonWorkHelperReturn(existing, operation, now);
    case "attach":
      if (operation.discoveredObjectiveId) {
        assertCommonWorkDiscoveryAllocation(existing, operation.discoveredObjectiveId);
      }
      return attachCommonWorkExecution(
        existing,
        {
          executionId: operation.executionId,
          generation: operation.generation,
          sessionKey: operation.sessionKey,
        },
        now,
      );
    case "terminal":
      return settleCommonWorkExecution(existing, operation, now).record;
    case "callback":
      return recordCommonWorkCallback(existing, operation, now);
    case "delivery":
      return recordCommonWorkDelivery(existing, operation, now);
    default:
      throw new CommonWorkConflictError("unsupported common-work operation");
  }
}
