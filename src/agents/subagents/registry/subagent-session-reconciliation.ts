/**
 * Subagent session-store reconciliation.
 *
 * Infers child completion from persisted session entries when registry updates arrive late.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
} from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getAgentRunContext, listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { getTaskRegistryProcessState } from "../../../tasks/task-registry.process-state.js";
import { hasTaskSessionOwnerInDatabase } from "../../../tasks/task-registry.store.kernel.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { hasRetainedRequiredCompletionDelivery } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { hasSubagentSessionOwnerInDatabase } from "./subagent-registry.store.sqlite.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";

export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

/** Completion inferred from the child session store. */
export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return asFiniteNumber(sessionEntry?.endedAt) ?? asFiniteNumber(sessionEntry?.updatedAt);
}

function isFreshForRun(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): boolean {
  if (notBeforeMs === undefined) {
    return true;
  }
  const terminalAt = terminalSessionTimestamp(sessionEntry);
  return terminalAt !== undefined && terminalAt >= notBeforeMs;
}

function freshSessionStartedAt(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): number | undefined {
  const startedAt = asFiniteNumber(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

/** Read the current child entry; session-key scope also selects incognito storage. */
export function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return loadSessionEntryReadOnly({
    agentId,
    storePath,
    sessionKey: key,
    clone: false,
  });
}

/** Resolves whether a registry row is orphaned from its child session entry. */
export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}): SubagentRunOrphanReason | null {
  const { entry } = params;
  // Execution, recovery, and completion obligations outlive individual turns.
  // Missing session metadata must not steal those owners or manufacture success.
  if (
    isSubagentChildStopUnconfirmed(entry) ||
    entry.execution.outcome ||
    entry.collectorCompletion ||
    entry.requesterSettleWake ||
    hasRetainedRequiredCompletionDelivery(entry) ||
    entry.pauseReason ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.restartRecovery ||
    entry.terminalOwner === "interrupted-recovery" ||
    entry.suppressAnnounceReason === "steer-restart" ||
    entry.execution.status === "queued" ||
    getAgentRunContext(entry.runId)
  ) {
    return null;
  }
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  try {
    const sessionEntry = loadSubagentSessionEntry({
      childSessionKey,
      cfg: params.cfg,
    });
    if (!sessionEntry) {
      return "missing-session-entry";
    }
    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }
    if (
      params.includeStaleUnended === true &&
      sessionEntry.abortedLastRun !== true &&
      params.entry.execution.status !== "interrupted" &&
      isStaleUnendedSubagentRun(params.entry, params.now)
    ) {
      return "stale-unended-run";
    }
    return null;
  } catch {
    // A failed read cannot establish orphanhood or authorize terminal settlement.
    return null;
  }
}

/** Convert persisted session status into a subagent completion outcome. */
export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  // Startup interruption has no terminal event timestamp and cannot settle the registry.
  if (
    status === "running" ||
    status === "interrupted" ||
    !isFreshForRun(sessionEntry, opts?.notBeforeMs)
  ) {
    return null;
  }
  let outcome: SubagentRunOutcome;
  let reason: SubagentLifecycleEndedReason = SUBAGENT_ENDED_REASON_COMPLETE;
  switch (status) {
    case "failed":
      outcome = { status: "error", error: "session completed before registry settled" };
      reason = SUBAGENT_ENDED_REASON_ERROR;
      break;
    case "killed":
      outcome = { status: "error", error: "subagent run terminated" };
      reason = SUBAGENT_ENDED_REASON_KILLED;
      break;
    case "timeout":
      outcome = { status: "timeout" };
      break;
    default:
      if (status !== "done" && typeof sessionEntry?.endedAt !== "number") {
        return null;
      }
      outcome = { status: "ok" };
  }
  return {
    startedAt: freshSessionStartedAt(sessionEntry, opts?.notBeforeMs),
    endedAt: terminalSessionTimestamp(sessionEntry) ?? fallbackEndedAt,
    outcome,
    reason,
  };
}

/** Resolve child completion by reading its persisted session entry. */
export function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  return resolveCompletionFromSessionEntry(
    loadSubagentSessionEntry({
      childSessionKey: params.childSessionKey,
      cfg: params.cfg,
    }),
    params.fallbackEndedAt,
    { notBeforeMs: params.notBeforeMs },
  );
}

/**
 * Settle a registry row from its persisted child session entry.
 *
 * This is the only liveness re-observation available without a live agent run
 * context: the session store is written by the child itself, so a terminal
 * status there is stop evidence. A nonterminal status does not establish
 * liveness, but leaves the stop unconfirmed. Callers relying on that
 * must not first overwrite the entry with their own derived status.
 *
 * Returns what the child's own record says:
 * - `settled` — terminal there, so the stop is observed and this completion has
 *   been submitted through the ordinary lifecycle path.
 * - `live` — the entry carries no fresh terminal evidence. Terminal effects must not
 *   run against it.
 * - `absent` — no usable session entry, so there is nothing to reconcile from.
 *   This is the absence of evidence, not evidence of a stop: the entry is
 *   best-effort and also reads absent when the store is unreadable or has not
 *   been written yet. Callers deciding whether a child may still be alive must
 *   fail closed on it rather than treat it as `settled`.
 */
export async function settleSubagentRunFromSessionStore(
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    now: number;
    source: string;
  },
): Promise<"settled" | "live" | "absent"> {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: args.entry.childSessionKey,
  });
  if (!sessionEntry) {
    return "absent";
  }
  const completion = resolveCompletionFromSessionEntry(sessionEntry, args.now, {
    notBeforeMs: args.entry.execution.startedAt ?? args.entry.createdAt,
  });
  if (!completion) {
    return "live";
  }
  await completeSubagentRunWithRecovery(
    {
      runId: args.runId,
      expectedEntry: args.entry,
      startedAt: completion.startedAt,
      endedAt: completion.endedAt,
      outcome: completion.outcome,
      reason: completion.reason,
      sendFarewell: true,
      accountId: args.entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    args.source,
  );
  return "settled";
}

/** Resolve a fresh child session start time for lifecycle reconciliation. */
export function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
}): number | undefined {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    cfg: params.cfg,
  });
  return isFreshForRun(sessionEntry, params.notBeforeMs)
    ? freshSessionStartedAt(sessionEntry, params.notBeforeMs)
    : undefined;
}

/** Startup may only settle session-only rows; any run/task generation retains ownership. */
export function hasSubagentSessionRecoveryOwner(params: {
  sessionKey: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const key = params.sessionKey;
  if (listAgentRunsForSession(params).length > 0) {
    return true;
  }
  for (const run of subagentRuns.values()) {
    if (
      run.childSessionKey === key ||
      run.requesterSessionKey === key ||
      run.controllerSessionKey === key
    ) {
      return true;
    }
  }
  const tasks = getTaskRegistryProcessState();
  if (tasks.projection.pending.size > 0) {
    return true;
  }
  for (const owner of tasks.runOwners.values()) {
    if (owner.task.childSessionKey === key || owner.task.ownerKey === key) {
      return true;
    }
  }
  for (const task of tasks.tasks.values()) {
    if (task.childSessionKey === key || task.requesterSessionKey === key || task.ownerKey === key) {
      return true;
    }
  }
  // Failed or incompatible reads propagate: unknown ownership never authorizes mutation.
  return (
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      (database) =>
        hasSubagentSessionOwnerInDatabase(database, key) ||
        hasTaskSessionOwnerInDatabase(database.db, key),
      { env: params.env },
    ) ?? false
  );
}
