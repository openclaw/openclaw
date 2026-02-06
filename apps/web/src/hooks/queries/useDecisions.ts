/**
 * Decision query hooks for the Decision Audit Log.
 */

import { useQuery } from "@tanstack/react-query";
import {
  listDecisions,
  getDecision,
  type DecisionListParams,
  type DecisionRecord,
} from "@/lib/api/decisions";
import type { DecisionAuditEntry, DecisionOutcome } from "@/components/domain/decisions/decision-types";

// =============================================================================
// Query Keys
// =============================================================================

export const decisionKeys = {
  all: ["decisions"] as const,
  lists: () => [...decisionKeys.all, "list"] as const,
  list: (params: DecisionListParams) => [...decisionKeys.lists(), params] as const,
  details: () => [...decisionKeys.all, "detail"] as const,
  detail: (id: string) => [...decisionKeys.details(), id] as const,
};

// =============================================================================
// Transform: DecisionRecord → DecisionAuditEntry
// =============================================================================

function toOutcome(record: DecisionRecord): DecisionOutcome {
  if (record.status === "pending") return "pending";
  if (record.status === "expired") return "expired";

  // responded — check response
  const val = record.response?.optionValue?.toLowerCase();
  if (val === "reject" || val === "cancel" || val === "deny") {
    return "rejected";
  }
  return "approved";
}

function toResponseValue(record: DecisionRecord): string | undefined {
  if (record.response?.textValue) return record.response.textValue;
  if (record.response?.optionValue) return record.response.optionValue;
  if (record.response?.optionId) {
    const option = record.options?.find((o) => o.id === record.response?.optionId);
    return option?.label ?? record.response.optionId;
  }
  return undefined;
}

function transformRecord(record: DecisionRecord): DecisionAuditEntry {
  return {
    id: record.decisionId,
    timestamp: record.createdAt,
    title: record.title,
    question: record.question,
    type: record.type,
    outcome: toOutcome(record),
    respondedBy: record.respondedBy?.userName ?? record.respondedBy?.userId,
    respondedAt: record.respondedAt,
    responseValue: toResponseValue(record),
    goalId: record.context.goalId,
    agentId: record.context.agentId,
    sessionKey: record.context.sessionKey,
    options: record.options?.map((o) => ({
      label: o.label,
      value: o.value,
      style: o.style,
    })),
  };
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Hook to fetch all decisions, transformed to DecisionAuditEntry format.
 */
export function useDecisions(params: DecisionListParams = {}) {
  return useQuery({
    queryKey: decisionKeys.list(params),
    queryFn: async (): Promise<DecisionAuditEntry[]> => {
      const records = await listDecisions(params);
      return records.map(transformRecord);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Hook to fetch a single decision by ID.
 */
export function useDecision(decisionId: string | null) {
  return useQuery({
    queryKey: decisionKeys.detail(decisionId ?? ""),
    queryFn: async (): Promise<DecisionAuditEntry | null> => {
      if (!decisionId) return null;
      const record = await getDecision(decisionId);
      return record ? transformRecord(record) : null;
    },
    enabled: !!decisionId,
    staleTime: 30_000,
  });
}
