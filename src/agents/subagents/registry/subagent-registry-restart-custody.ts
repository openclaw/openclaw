// Continuation custody across a Gateway restart (RFC docs/design/continue-work-signal-v2.md
// §5.4.4, boundary 5). A continuation delegate hands custody to its `subagent_runs` row at
// admission. Upstream #185730 keeps restored rows as history and no longer settles a child that
// the previous lifecycle left running, so a delegate the bounded shutdown kill did not reach, or
// one a crash stranded, would stay `running` with no execution owner. Gateway activation settles
// those rows once: terminal with an explicit interruption, no completion text, never relaunched,
// and no child-session effects. The interruption is the delegate's one outcome, owed to its
// requester like the shutdown's own (upstream #201544): startup's restart completion recovery
// admits it under current authority and delivers it through the delegate's return mode. The
// sweeper never adds a second outcome for it. A delegate its requester had already asked to stop
// keeps that election and closes quietly, as the finished kill would have.
//
// The same pass accounts for a delegate whose child session entry is missing (🌊's ruling on
// upstream #201970). That entry carries the spawn lineage the shutdown's root walk follows, so no
// root was inferred or resumed for the delegate. While its row still binds a requester that
// restart completion recovery admits, its one outcome says the lineage is missing and the
// election's outcome unknown, once, through its return mode. Otherwise the row records why no
// binding survived and closes without delivering anything.
import { getRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { parseContinuationChildRunId } from "../../../shared/continuation-run-key.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import {
  resolveRecordedRequester,
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import { ensureCompletionState, ensureDeliveryState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import { subagentRegistryLog as log } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { isAcceptedSpawnCustodyRow } from "./subagent-registry-spawn-acceptance.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

/** The error upstream's graceful shutdown records (terminateLiveSubagentsForShutdown). */
export const SUBAGENT_GATEWAY_STOPPED_ERROR = "Gateway stopped";
export const SUBAGENT_RESTART_INTERRUPTED_ERROR =
  "subagent run interrupted: the Gateway restarted before it ended";

/**
 * A delegate execution owned only by an earlier lifecycle: rotation makes every prior-generation
 * owner unreachable. H1 acceptance custody keeps its own owner. A pending kill keeps the
 * sweeper's durable kill reconcile until restore retires the row's completion authority; the
 * sweeper never reconciles a retired row, so that kill is settled here.
 */
function isOwnerlessContinuationChild(entry: SubagentRunRecord): boolean {
  const { lifecycleGeneration, status } = entry.execution;
  return (
    entry.drainsContinuationDelegateQueue === true &&
    !hasSubagentRunEnded(entry) &&
    (status === "running" || status === "interrupted") &&
    !(lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) &&
    (!entry.killIntent || subagentRuns.isCompletionAuthorityRetired(entry)) &&
    !isAcceptedSpawnCustodyRow(entry) &&
    resolveSubagentChildAuthority(entry).status !== "mismatch"
  );
}

async function settleOwnerlessContinuationChildren(): Promise<SubagentRunRecord[]> {
  const selected = [...subagentRuns.values()].filter(isOwnerlessContinuationChild);
  if (selected.length === 0) {
    return [];
  }
  const endedAt = Date.now();
  const settled = await mutateSubagentRuns(
    selected.map((entry) => entry.runId),
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const expected of selected) {
        const current = rows.get(expected.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, expected) ||
          !isOwnerlessContinuationChild(current)
        ) {
          continue;
        }
        const entry = structuredClone(current);
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          endedAt,
          suppressSessionEffects: true,
          outcome: withSubagentOutcomeTiming(
            { status: "error", error: SUBAGENT_RESTART_INTERRUPTED_ERROR },
            { startedAt: entry.execution.startedAt, endedAt },
          ),
        };
        entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        // A kill the earlier lifecycle never finished has no owner either. Recording it as a
        // kill would retire the row at cleanup; the interruption keeps it inspectable.
        const stoppedByRequester = entry.killIntent !== undefined;
        entry.killIntent = undefined;
        // An error outcome freezes no result text, as the canonical completion does.
        const completion = ensureCompletionState(entry);
        completion.resultText = null;
        completion.capturedAt = endedAt;
        if (stoppedByRequester) {
          entry.suppressCompletionDelivery = true;
          ensureDeliveryState(entry).disposition = "intentional_non_delivery";
        } else {
          // Owed to the requester: pending, unless the row expects no completion.
          ensureDeliveryState(entry);
        }
        postimages.set(entry.runId, entry);
      }
      return { value: [...postimages.values()], postimages };
    },
    { runs: subagentRuns },
  ).catch((error: unknown) => {
    log.warn("failed to settle continuation children left running by an earlier Gateway", {
      error,
      runIds: selected.map((entry) => entry.runId),
    });
    return [];
  });
  for (const entry of settled) {
    // Suppressed session effects skip the cleanup flow's own removal, as for a shutdown kill.
    if (shouldRemoveSubagentAttachments(entry)) {
      await safeRemoveAttachmentsDir(entry);
    }
  }
  return settled;
}

type LineageMissing = NonNullable<SubagentRunRecord["continuationLineageMissing"]>;

/** A delegate a Gateway restart ended whose owed outcome has no lineage decision yet. */
function owesRestartOutcome(entry: SubagentRunRecord): boolean {
  const { outcome } = entry.execution;
  const error = outcome?.status === "error" ? outcome.error : undefined;
  const delivery = entry.delivery?.status;
  return (
    entry.drainsContinuationDelegateQueue === true &&
    entry.continuationLineageMissing === undefined &&
    !entry.suppressCompletionDelivery &&
    entry.execution.status === "terminal" &&
    (error === SUBAGENT_GATEWAY_STOPPED_ERROR || error === SUBAGENT_RESTART_INTERRUPTED_ERROR) &&
    (delivery === "pending" || delivery === "in_progress" || delivery === "failed")
  );
}

function resolveStorePath(agentId: string, recorded?: string): string {
  return (
    recorded ?? resolveSessionStorePathCore(getRuntimeConfigSnapshot()?.session?.store, { agentId })
  );
}

/**
 * Undefined while the child session entry exists. Otherwise the binding restart completion
 * recovery admits through: the recorded requester agent and its current, unarchived session.
 */
async function checkRestartLineage(
  entry: SubagentRunRecord,
): Promise<Omit<LineageMissing, "recordedAt"> | undefined> {
  const childAgentId = resolveSubagentChildAgentId(entry);
  if (!childAgentId) {
    return undefined;
  }
  const child = await readSessionEntryReadOnlyInWorker({
    sessionKey: entry.childSessionKey,
    agentId: childAgentId,
    storePath: resolveStorePath(childAgentId),
    projection: "list",
  });
  if (child) {
    return undefined;
  }
  const requesterAgentId = entry.requesterAgentId ? resolveRecordedRequester(entry) : undefined;
  if (!requesterAgentId) {
    return { unresolved: "requester-agent-unresolved" };
  }
  const requester = await readSessionEntryReadOnlyInWorker({
    sessionKey: entry.requesterSessionKey,
    agentId: requesterAgentId,
    storePath: resolveStorePath(requesterAgentId, entry.requesterStorePath),
    projection: "list",
  });
  return !requester
    ? { unresolved: "requester-session-missing" }
    : requester.archivedAt !== undefined
      ? { unresolved: "requester-session-archived" }
      : {};
}

/** Records each owed restart outcome whose lineage is missing, once per row. */
async function recordMissingContinuationLineage(): Promise<SubagentRunRecord[]> {
  const candidates = [...subagentRuns.values()].filter(owesRestartOutcome);
  const checked = await Promise.all(
    candidates.map(async (entry) => {
      try {
        return { entry, lineage: await checkRestartLineage(entry) };
      } catch (error) {
        // Undecided: the outcome keeps its ordinary wording, and the next activation checks again.
        log.warn("failed to check a continuation delegate's restart lineage", {
          runId: entry.runId,
          error,
        });
        return { entry, lineage: undefined };
      }
    }),
  );
  const missing = checked.flatMap(({ entry, lineage }) => (lineage ? [{ entry, lineage }] : []));
  if (missing.length === 0) {
    return [];
  }
  const recordedAt = Date.now();
  const recorded = await mutateSubagentRuns(
    missing.map(({ entry }) => entry.runId),
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const { entry: expected, lineage } of missing) {
        const current = rows.get(expected.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, expected) ||
          !owesRestartOutcome(current)
        ) {
          continue;
        }
        const entry = structuredClone(current);
        entry.continuationLineageMissing = { recordedAt, ...lineage };
        if (lineage.unresolved) {
          // Nothing binds a recipient: no notice is broadcast, and none is sent to a guessed one.
          entry.suppressCompletionDelivery = true;
          ensureDeliveryState(entry).disposition = "intentional_non_delivery";
        }
        postimages.set(entry.runId, entry);
      }
      return { value: [...postimages.values()], postimages };
    },
    { runs: subagentRuns },
  ).catch((error: unknown) => {
    log.warn("failed to record missing continuation delegate restart lineage", {
      error,
      runIds: missing.map(({ entry }) => entry.runId),
    });
    return [];
  });
  for (const entry of recorded) {
    const reason = entry.continuationLineageMissing?.unresolved;
    if (reason) {
      log.warn("continuation delegate restart lineage missing; outcome left unresolved", {
        runId: entry.runId,
        electionId: parseContinuationChildRunId(entry.runId)?.recordId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        reason,
      });
    }
  }
  return recorded;
}

/**
 * Runs on Gateway activation, before restart resume discovers what each requester is owed and
 * before any delivery starts. Best effort: a failed read or write is logged and the rows wait
 * for the next activation, so it never blocks the restart resume.
 */
export async function settleContinuationRestartCustody(
  startSubagentAnnounceCleanupFlow: (entry: SubagentRunRecord) => boolean,
): Promise<void> {
  const settled = await settleOwnerlessContinuationChildren();
  const latest = new Map(settled.map((entry) => [entry.runId, entry]));
  for (const entry of await recordMissingContinuationLineage()) {
    // An unresolved row closes quietly now; a notice keeps the delivery path its row already had.
    if (entry.continuationLineageMissing?.unresolved || latest.has(entry.runId)) {
      latest.set(entry.runId, entry);
    }
  }
  for (const entry of latest.values()) {
    // Retired completion custody (a new process) waits for restart completion recovery to
    // admit the owed outcome; live custody (an in-process restart) delivers it now, and a row
    // that owes none finishes cleanup now.
    if (
      entry.suppressCompletionDelivery ||
      entry.delivery?.status === "not_required" ||
      !subagentRuns.isCompletionAuthorityRetired(entry)
    ) {
      startSubagentAnnounceCleanupFlow(entry);
    }
  }
}
