/**
 * DELEGATION REGISTRY
 *
 * In-memory registry for delegation records with disk persistence.
 * Pattern follows subagent-registry.ts.
 */

import type { AgentRole } from "../config/types.agents.js";
import type {
  DelegationDirection,
  DelegationInteraction,
  DelegationMetrics,
  DelegationPriority,
  DelegationRecord,
  DelegationResult,
  DelegationReview,
  DelegationState,
} from "./delegation-types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { AGENT_ROLE_RANK } from "./agent-scope.js";
import { loadAllDelegationRecords, saveDelegationRecord } from "./delegation-storage.js";

const delegations = new Map<string, DelegationRecord>();
let restoreAttempted = false;

function persist(record: DelegationRecord) {
  void saveDelegationRecord(record);
}

async function restoreOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = await loadAllDelegationRecords();
    for (const [id, record] of restored.entries()) {
      if (!delegations.has(id)) {
        delegations.set(id, record);
      }
    }
  } catch {
    // ignore restore failures
  }
}

/**
 * Determine delegation direction between two roles.
 * Higher rank delegates downward; lower rank requests upward; peers delegate directly.
 */
export function resolveDelegationDirection(
  fromRole: AgentRole,
  toRole: AgentRole,
): DelegationDirection {
  const fromRank = AGENT_ROLE_RANK[fromRole];
  const toRank = AGENT_ROLE_RANK[toRole];
  if (fromRank >= toRank) {
    return "downward";
  }
  return "upward";
}

/**
 * Validate that a state transition is allowed.
 */
const VALID_TRANSITIONS: Record<DelegationState, DelegationState[]> = {
  created: ["pending_review", "assigned", "rejected"],
  pending_review: ["assigned", "rejected", "redirected"],
  assigned: ["in_progress", "rejected"],
  in_progress: ["completed", "failed"],
  completed: [],
  rejected: [],
  failed: [],
  redirected: [],
};

function canTransition(from: DelegationState, to: DelegationState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function registerDelegation(params: {
  fromAgentId: string;
  fromSessionKey: string;
  fromRole: AgentRole;
  toAgentId: string;
  toSessionKey?: string;
  toRole: AgentRole;
  task: string;
  priority?: DelegationPriority;
  justification?: string;
}): DelegationRecord {
  const direction = resolveDelegationDirection(params.fromRole, params.toRole);
  const now = Date.now();
  const id = `deleg:${params.fromAgentId}:${params.toAgentId}:${now}`;

  // Upward requests go to pending_review; downward delegations go straight to assigned
  const initialState: DelegationState = direction === "upward" ? "pending_review" : "assigned";

  const record: DelegationRecord = {
    id,
    direction,
    state: initialState,
    priority: params.priority ?? "normal",
    fromAgentId: params.fromAgentId,
    fromSessionKey: params.fromSessionKey,
    fromRole: params.fromRole,
    toAgentId: params.toAgentId,
    toSessionKey: params.toSessionKey,
    toRole: params.toRole,
    task: params.task,
    justification: params.justification,
    interactions: [
      {
        agentId: params.fromAgentId,
        type: "status_update",
        timestamp: now,
      },
    ],
    createdAt: now,
  };

  delegations.set(id, record);
  persist(record);
  emitAgentEvent({
    runId: id,
    stream: "delegation",
    data: {
      phase: "delegation-created",
      delegationId: id,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
    },
    sessionKey: params.fromSessionKey,
  });
  return record;
}

export function updateDelegationState(
  id: string,
  newState: DelegationState,
): DelegationRecord | null {
  const record = delegations.get(id);
  if (!record) {
    return null;
  }
  if (!canTransition(record.state, newState)) {
    return null;
  }

  record.state = newState;
  const now = Date.now();

  if (newState === "in_progress") {
    record.startedAt = now;
  }
  if (newState === "completed" || newState === "failed") {
    record.completedAt = now;
  }

  record.interactions.push({
    agentId: record.toAgentId,
    type: "status_update",
    timestamp: now,
  });

  persist(record);
  return record;
}

export function reviewDelegation(id: string, review: DelegationReview): DelegationRecord | null {
  const record = delegations.get(id);
  if (!record) {
    return null;
  }
  if (record.state !== "pending_review") {
    return null;
  }

  record.review = review;
  record.reviewedAt = Date.now();

  if (review.decision === "approve") {
    record.state = "assigned";
  } else if (review.decision === "reject") {
    record.state = "rejected";
  } else if (review.decision === "redirect") {
    record.state = "redirected";
  }

  record.interactions.push({
    agentId: review.reviewerId,
    type: "review",
    timestamp: Date.now(),
  });

  persist(record);
  emitAgentEvent({
    runId: id,
    stream: "delegation",
    data: { phase: "delegation-reviewed", delegationId: id, decision: review.decision },
    sessionKey: record.fromSessionKey,
  });
  return record;
}

export function completeDelegation(id: string, result: DelegationResult): DelegationRecord | null {
  const record = delegations.get(id);
  if (!record) {
    return null;
  }
  if (record.state !== "in_progress" && record.state !== "assigned") {
    return null;
  }

  record.result = result;
  record.state = result.status === "failure" ? "failed" : "completed";
  record.completedAt = Date.now();

  record.interactions.push({
    agentId: record.toAgentId,
    type: "status_update",
    timestamp: Date.now(),
  });

  persist(record);
  emitAgentEvent({
    runId: id,
    stream: "delegation",
    data: { phase: "delegation-completed", delegationId: id, status: result.status },
    sessionKey: record.fromSessionKey,
  });
  return record;
}

export function redirectDelegation(
  id: string,
  redirectTo: { agentId: string; reason: string },
): DelegationRecord | null {
  const record = delegations.get(id);
  if (!record) {
    return null;
  }
  if (record.state !== "pending_review") {
    return null;
  }

  record.state = "redirected";
  record.redirectedTo = redirectTo;

  record.interactions.push({
    agentId: record.toAgentId,
    type: "status_update",
    timestamp: Date.now(),
  });

  persist(record);
  emitAgentEvent({
    runId: id,
    stream: "delegation",
    data: { phase: "delegation-redirected", delegationId: id, redirectTo: redirectTo.agentId },
    sessionKey: record.fromSessionKey,
  });
  return record;
}

export function addDelegationInteraction(id: string, interaction: DelegationInteraction): void {
  const record = delegations.get(id);
  if (!record) {
    return;
  }
  record.interactions.push(interaction);
  persist(record);
}

export function getDelegation(id: string): DelegationRecord | null {
  return delegations.get(id) ?? null;
}

export function listDelegationsForAgent(
  agentId: string,
  filter?: { direction?: DelegationDirection; state?: DelegationState },
): DelegationRecord[] {
  const results: DelegationRecord[] = [];
  for (const record of delegations.values()) {
    if (record.fromAgentId !== agentId && record.toAgentId !== agentId) {
      continue;
    }
    if (filter?.direction && record.direction !== filter.direction) {
      continue;
    }
    if (filter?.state && record.state !== filter.state) {
      continue;
    }
    results.push(record);
  }
  return results;
}

export function listPendingReviewsForAgent(agentId: string): DelegationRecord[] {
  const results: DelegationRecord[] = [];
  for (const record of delegations.values()) {
    if (record.state !== "pending_review") {
      continue;
    }
    // Upward requests: the "toAgentId" (superior) is the reviewer
    if (record.toAgentId === agentId) {
      results.push(record);
    }
  }
  return results;
}

export function getAgentDelegationMetrics(agentId: string): DelegationMetrics {
  let sent = 0;
  let received = 0;
  let pending = 0;
  let completed = 0;
  let rejected = 0;
  let interactionCount = 0;

  for (const record of delegations.values()) {
    if (record.fromAgentId === agentId) {
      sent++;
    }
    if (record.toAgentId === agentId) {
      received++;
    }
    if (
      (record.fromAgentId === agentId || record.toAgentId === agentId) &&
      (record.state === "pending_review" || record.state === "assigned")
    ) {
      pending++;
    }
    if (
      (record.fromAgentId === agentId || record.toAgentId === agentId) &&
      record.state === "completed"
    ) {
      completed++;
    }
    if (
      (record.fromAgentId === agentId || record.toAgentId === agentId) &&
      record.state === "rejected"
    ) {
      rejected++;
    }
    for (const interaction of record.interactions) {
      if (interaction.agentId === agentId) {
        interactionCount++;
      }
    }
  }

  return { sent, received, pending, completed, rejected, interactionCount };
}

export function getAllDelegations(): DelegationRecord[] {
  return [...delegations.values()];
}

export async function initDelegationRegistry() {
  await restoreOnce();
}

export function resetDelegationRegistryForTests() {
  delegations.clear();
  restoreAttempted = false;
}
