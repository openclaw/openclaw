// Continuation (karmaterminal): a session reset (/new, /reset) replaces the conversational head
// but keeps the continuation-elected delegate tree. Before upstream's reset kill runs, the reset
// durably marks each continuation run it retains; the kill skips only runs marked by the reset in
// flight (subagent-continuation-reset-active.ts). Results from a run whose mark is still pending
// are held until the reset's successor is proven (adopted) or the reset is known not to have
// committed (aborted). The mark never touches run identity (requester key, agent or store).
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type {
  ActiveContinuationReset,
  ContinuationResetRetention,
  ContinuationResetRetentionOutcome,
} from "./subagent-continuation-reset-active.js";
import { isDeliverySuspendedUnbound } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** A terminal return held this long by an unresolved reset expires to failed, never delivered. */
export const CONTINUATION_RESET_HOLD_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The reset mark that withholds this run's continuation results from the session whose head a
 * reset replaced. A pending mark holds them until the successor is proven; an orphaned mark is a
 * durable fence that discards them, so no later head on the key ever receives them. Returns to
 * other sessions are not this reset's to hold.
 */
export function findContinuationResetHold(
  runId: string | undefined,
  recipientSessionKey: string,
): ContinuationResetRetention | undefined {
  const mark =
    runId === undefined ? undefined : subagentRuns.get(runId)?.continuationResetRetention;
  return mark?.sessionKey === recipientSessionKey &&
    (mark.state === "pending" || mark.state === "orphaned")
    ? mark
    : undefined;
}

/**
 * Continuation-elected runs the reset of this session may retain. Ordinary runs never qualify, nor
 * does a suspended-unbound outcome: it is owed to no session on this key.
 */
function selectRetainableContinuationRuns(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): SubagentRunRecord[] {
  const selected: SubagentRunRecord[] = [];
  for (const entry of subagentRuns.values()) {
    if (
      entry.continuationRecipientAuthorityBinding !== undefined &&
      entry.requesterSessionKey === params.sessionKey &&
      resolveSubagentRequesterAgentId(params.cfg, entry) === params.agentId &&
      entry.cleanupCompletedAt === undefined &&
      entry.killIntent === undefined &&
      !isDeliverySuspendedUnbound(entry)
    ) {
      selected.push(entry);
    }
  }
  return selected;
}

/** Durably marks the runs a reset retains, before its kill reads the selection. Returns their ids. */
export async function markContinuationRunsRetainedByReset(params: {
  cfg: OpenClawConfig;
  reset: ActiveContinuationReset;
  fromRevision?: string;
  toRevision: string;
  assertCurrent?: () => void;
}): Promise<string[]> {
  const { reset } = params;
  const expected = new Map(
    selectRetainableContinuationRuns({ cfg: params.cfg, ...reset }).map((entry) => [
      entry.runId,
      entry,
    ]),
  );
  if (expected.size === 0) {
    return [];
  }
  const markedAt = Date.now();
  return await mutateSubagentRuns(
    [...expected.keys()],
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const [runId, snapshot] of expected) {
        const entry = rows.get(runId);
        // A run that changed owner or ended its custody since selection is left to the kill.
        if (!entry || !isSameSubagentRunOwner(entry, snapshot)) {
          continue;
        }
        postimages.set(runId, {
          ...entry,
          continuationResetRetention: {
            resetId: reset.resetId,
            sessionKey: reset.sessionKey,
            agentId: reset.agentId,
            ...(params.fromRevision ? { fromRevision: params.fromRevision } : {}),
            toRevision: params.toRevision,
            state: "pending",
            markedAt,
          },
        });
      }
      return { value: [...postimages.keys()], postimages };
    },
    { assertCurrent: params.assertCurrent },
  );
}

/** Pending marks of one session, oldest first. */
export function listPendingContinuationResetRetentions(params?: {
  sessionKey?: string;
  agentId?: string;
}): SubagentRunRecord[] {
  return [...subagentRuns.values()]
    .filter((entry) => {
      const mark = entry.continuationResetRetention;
      return (
        mark?.state === "pending" &&
        (params?.sessionKey === undefined || mark.sessionKey === params.sessionKey) &&
        (params?.agentId === undefined || mark.agentId === params.agentId)
      );
    })
    .toSorted(
      (a, b) =>
        (a.continuationResetRetention?.markedAt ?? 0) -
        (b.continuationResetRetention?.markedAt ?? 0),
    );
}

/** Settles pending marks with a proven outcome. A mark changed since it was read is left alone. */
export async function settleContinuationResetRetentions(
  outcomes: ReadonlyMap<
    string,
    { expected: SubagentRunRecord; state: ContinuationResetRetentionOutcome }
  >,
): Promise<string[]> {
  if (outcomes.size === 0) {
    return [];
  }
  const resolvedAt = Date.now();
  return await mutateSubagentRuns([...outcomes.keys()], (rows) => {
    const postimages = new Map<string, SubagentRunRecord>();
    for (const [runId, { expected, state }] of outcomes) {
      const entry = rows.get(runId);
      const mark = entry?.continuationResetRetention;
      if (
        !entry ||
        !mark ||
        mark.state !== "pending" ||
        mark.resetId !== expected.continuationResetRetention?.resetId ||
        !isSameSubagentRunOwner(entry, expected)
      ) {
        continue;
      }
      postimages.set(runId, {
        ...entry,
        continuationResetRetention: { ...mark, state, resolvedAt },
      });
    }
    return { value: [...postimages.keys()], postimages };
  });
}
