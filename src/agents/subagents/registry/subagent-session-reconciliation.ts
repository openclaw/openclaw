import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
} from "../../../config/sessions.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { hasRetainedRequiredCompletionDelivery } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";

export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

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
export async function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  childAgentId?: string;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SessionEntry | undefined> {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key, params.childAgentId);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return readSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: key, projection: "list" },
    params.assertCurrent,
  );
}

export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}):
  | SubagentRunOrphanReason
  | null
  | {
      read: (assertCurrent: () => void) => Promise<{
        orphanReason: SubagentRunOrphanReason | null;
        sessionEntry: SessionEntry | undefined;
      }>;
    } {
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
  return {
    async read(assertCurrent) {
      const sessionEntry = await loadSubagentSessionEntry({
        childSessionKey,
        childAgentId: entry.childAgentId,
        cfg: params.cfg,
        assertCurrent,
      });
      let orphanReason: SubagentRunOrphanReason | null = null;
      if (!sessionEntry) {
        orphanReason = "missing-session-entry";
      } else if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
        orphanReason = "missing-session-id";
      } else if (
        params.includeStaleUnended === true &&
        sessionEntry.abortedLastRun !== true &&
        entry.execution.status !== "interrupted" &&
        isStaleUnendedSubagentRun(entry, params.now)
      ) {
        orphanReason = "stale-unended-run";
      }
      return { orphanReason, sessionEntry };
    },
  };
}

export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  // Interruption leaves registry settlement with the recovery owner.
  if (status === "interrupted" || !isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
    return null;
  }
  let outcome: SubagentRunOutcome;
  let reason: SubagentLifecycleEndedReason = SUBAGENT_ENDED_REASON_COMPLETE;
  switch (status) {
    case "failed":
      outcome = {
        status: "error",
        error: sessionEntry?.lastRunError || "session completed before registry settled",
      };
      reason = SUBAGENT_ENDED_REASON_ERROR;
      break;
    case "killed":
      outcome = { status: "error", error: "subagent run terminated" };
      reason = SUBAGENT_ENDED_REASON_KILLED;
      break;
    case "timeout":
      outcome = { status: "timeout", error: sessionEntry?.lastRunError };
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

export async function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  childAgentId?: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SubagentSessionCompletion | null> {
  return withSubagentSessionEntry(params, (entry) =>
    resolveCompletionFromSessionEntry(entry, params.fallbackEndedAt, {
      notBeforeMs: params.notBeforeMs,
    }),
  );
}

async function withSubagentSessionEntry<T>(
  params: {
    childSessionKey: string;
    childAgentId?: string;
    cfg?: OpenClawConfig;
    assertCurrent?: () => void;
  },
  consume: (entry: SessionEntry | undefined) => T,
): Promise<T> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params, cfg);
  return withSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: params.childSessionKey, projection: "list" },
    () => params.assertCurrent?.(),
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return consume(read.value);
    },
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
    assertCurrent?: () => void;
  },
): Promise<"settled" | "live" | "absent"> {
  const completion = await withSubagentSessionEntry(
    {
      childSessionKey: args.entry.childSessionKey,
      childAgentId: args.entry.childAgentId,
      assertCurrent: args.assertCurrent,
    },
    (sessionEntry) =>
      sessionEntry
        ? resolveCompletionFromSessionEntry(sessionEntry, args.now, {
            notBeforeMs: args.entry.execution.startedAt ?? args.entry.createdAt,
          })
        : "absent",
  );
  if (completion === "absent") {
    return "absent";
  }
  if (!completion) {
    return "live";
  }
  args.assertCurrent?.();
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

export async function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  childAgentId?: string;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<number | undefined> {
  return withSubagentSessionEntry(params, (entry) =>
    isFreshForRun(entry, params.notBeforeMs)
      ? freshSessionStartedAt(entry, params.notBeforeMs)
      : undefined,
  );
}
