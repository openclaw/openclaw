import { isDeepStrictEqual } from "node:util";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-log.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { RequesterInitialTransfer } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  copySubagentRunRuntimeOwner,
  currentSubagentRunOrObserved,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

// Reporting thresholds never change the durable obligation or retry cadence.
const REQUESTER_SETTLE_WAKE_COMMIT_SUSTAINED_FAILURES = 5;

const REQUESTER_SETTLE_WAKE_COMMIT_MAX_BACKOFF_MS = 120_000;

// Count emitted reports separately: not every reported rejection advances commit failures.
const REQUESTER_SETTLE_WAKE_FAILURE_REPORT_BUDGET = 5;

type WakeCommitFailureRetention =
  | boolean
  | ((error: unknown, pending: PendingRequesterSettleWakeCommit) => boolean);

/** Release only the fence slots this episode still owns; a newer episode keeps its own. */
function releasePendingWakeKeys(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  for (const entry of pending.entries) {
    const key = getSubagentRunRuntimeKey(entry);
    if (context.pendingRequesterSettleWakeCommits.get(key) === pending) {
      context.pendingRequesterSettleWakeCommits.delete(key);
    }
  }
}

function clearPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  releasePendingWakeKeys(context, pending);
  const suppressed = pending.suppressedFailureLogs ?? 0;
  if (suppressed > 0) {
    // Closing the episode accounts for what it withheld, so a log that went
    // quiet is never read as an outage that stopped happening.
    context.options.warn("requester settle wake commit recovered", {
      failures: pending.failures,
      suppressedFailureLogs: suppressed,
      runIds: pending.entries.map((entry) => maskLifecycleIdentifier(entry.runId, "run")),
    });
  }
}

/** Bound identical reports per episode; a different failure always gets a fresh budget. */
export function shouldReportRequesterSettleWakeFailure(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  error: Record<string, string>,
): boolean {
  const pending = getPendingWakeCommit(context, entry);
  if (!pending) {
    // No retry episode owns this failure, so nothing is going to repeat it.
    return true;
  }
  const signature = `${error.name ?? ""}\u0000${error.message ?? ""}`;
  if (pending.reportedFailureSignature !== signature) {
    pending.reportedFailureSignature = signature;
    pending.reportedFailureLogs = 1;
    return true;
  }
  const reported = pending.reportedFailureLogs ?? 0;
  if (reported < REQUESTER_SETTLE_WAKE_FAILURE_REPORT_BUDGET) {
    pending.reportedFailureLogs = reported + 1;
    return true;
  }
  pending.suppressedFailureLogs = (pending.suppressedFailureLogs ?? 0) + 1;
  return false;
}

export function getPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
): PendingRequesterSettleWakeCommit | undefined {
  const pending = context.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry));
  if (pending && !pending.isCurrent(entry)) {
    // A changed row relinquishes only its own obligation. Surviving siblings
    // must keep the known outcome or replay budget ahead of transport.
    context.pendingRequesterSettleWakeCommits.delete(getSubagentRunRuntimeKey(entry));
    return undefined;
  }
  return pending;
}

export function hasRequesterWakeOwner(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
): boolean {
  const current = context.options.runs.get(entry.runId);
  const pending = getPendingWakeCommit(context, entry);
  return (
    isSameSubagentRunOwner(current, entry) ||
    (current === undefined && pending?.ownsRetirement(entry) === true)
  );
}

/** Commit the cohort before publishing its in-memory continuation facts. */
export function commitRequesterInitialTransfer(
  context: SubagentLifecycleWakeContext,
  params: Parameters<RequesterInitialTransfer>[0] & {
    stateContext: OpenClawStateWorkerContext;
    assertCurrent(): void;
  },
): Promise<void> {
  const existing = params.entries
    .map((entry) => getPendingWakeCommit(context, entry))
    .find((pending) => pending !== undefined);
  if (existing) {
    return Promise.reject(new Error("Another requester transfer is already pending"));
  }
  const completion = createDeferredCore();
  let committed = false;
  const retiredRunIds = new Set<string>();
  const initialTransfer = {
    kind: params.kind,
    completion: completion.promise,
    completed: false,
  };
  const currentEntries = () =>
    pending.entries.map((entry) => currentSubagentRunOrObserved(context.options.runs, entry));
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...params.entries],
    generation: undefined,
    stateContext: params.stateContext,
    initialTransfer,
    failures: 0,
    nextAttemptAt: 0,
    isCurrent: (entry) =>
      isSameSubagentRunOwner(context.options.runs.get(entry.runId), entry) ||
      retiredRunIds.has(entry.runId),
    ownsRetirement: (entry) => retiredRunIds.has(entry.runId),
    adoptPublished: () => currentEntries(),
    commit: () => completion.promise.then(() => true),
  };
  for (const entry of pending.entries) {
    context.pendingRequesterSettleWakeCommits.set(getSubagentRunRuntimeKey(entry), pending);
  }
  const operation = Promise.resolve().then(async () => {
    params.assertCurrent();
    await params.prepare?.();
    params.assertCurrent();
    let published = false;
    const result = await mutateSubagentRuns(
      pending.entries.map((entry) => entry.runId),
      (rows) => {
        params.validateSelection?.();
        const drafts = pending.entries.map((entry) => {
          const current = rows.get(entry.runId);
          if (!current || !isSameSubagentRunOwner(current, entry)) {
            throw new SubagentRegistryMutationRejectedError(
              "Requester transfer no longer owns its selected row",
            );
          }
          return copySubagentRunRuntimeOwner(current, structuredClone(current));
        });
        const retiring = params.mutate(drafts);
        const handoff = drafts.map((entry) =>
          copySubagentRunRuntimeOwner(entry, structuredClone(entry)),
        );
        // The host publishes continuation facts before notifying readers. There
        // is no second write or retry protocol if that bookkeeping fails.
        params.release?.(drafts);
        const postimages = new Map<string, SubagentRunRecord | null>();
        for (const entry of drafts) {
          if (retiring?.has(entry.runId)) {
            retiredRunIds.add(entry.runId);
            postimages.set(entry.runId, null);
          } else if (!isDeepStrictEqual(entry, rows.get(entry.runId))) {
            postimages.set(entry.runId, entry);
          }
        }
        return { value: { handoff, drafts }, postimages };
      },
      {
        runs: context.options.runs,
        context: params.stateContext,
        assertCurrent: () => params.assertCurrent(),
        onPublished: (_postimages, value) => {
          committed = true;
          published = true;
          pending.entries = value.drafts;
          params.assertCurrent();
          params.finish(value.handoff);
        },
      },
    );
    committed = true;
    if (!published) {
      pending.entries = result.drafts;
      params.assertCurrent();
      params.finish(result.handoff);
    }
    params.afterRelease?.(currentEntries());
    initialTransfer.completed = true;
  });
  pending.inFlight = operation;
  void operation.then(
    () => {
      releasePendingWakeKeys(context, pending);
      completion.resolve();
    },
    (error: unknown) => {
      releasePendingWakeKeys(context, pending);
      completion.reject(
        error instanceof SubagentRegistryWriteError
          ? error
          : new SubagentRegistryWriteError(
              committed ? "committed" : "not-committed",
              error,
              committed ? "published" : undefined,
            ),
      );
    },
  );
  return completion.promise;
}

function deferWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  pending.failures += 1;
  if (
    pending.failures >= REQUESTER_SETTLE_WAKE_COMMIT_SUSTAINED_FAILURES &&
    !pending.sustainedFailureReported
  ) {
    // Explain why per-attempt reporting will go quiet while retries continue.
    pending.sustainedFailureReported = true;
    context.options.warn("requester settle wake commit still failing; retries continue", {
      failures: pending.failures,
      retryIntervalMs: REQUESTER_SETTLE_WAKE_COMMIT_MAX_BACKOFF_MS,
      suppressingIdenticalFailures: true,
      runIds: pending.entries.map((entry) => maskLifecycleIdentifier(entry.runId, "run")),
    });
  }
  // Always a future deadline. The lifecycle owner arms its retry timer from
  // this value and skips any deadline that is not ahead of now, so a deadline
  // in the past would strand the pending wake until restart.
  pending.nextAttemptAt =
    Date.now() +
    Math.min(REQUESTER_SETTLE_WAKE_COMMIT_MAX_BACKOFF_MS, 30_000 * 2 ** (pending.failures - 1));
}

// Persistence failure cannot erase a transport result or its replay budget. Keep
// that exact operation in the lifecycle owner, ahead of every later transport.
export function commitRequesterWake(
  context: SubagentLifecycleWakeContext,
  observedEntries: readonly SubagentRunRecord[],
  generation: number | undefined,
  commit: PendingRequesterSettleWakeCommit["commit"],
  retainOnFailure: WakeCommitFailureRetention,
  stateContext?: OpenClawStateWorkerContext,
): Promise<void> {
  const predecessors = new Set(
    observedEntries.flatMap((entry) => {
      const pending = getPendingWakeCommit(context, entry);
      return pending ? [pending] : [];
    }),
  );
  if (predecessors.size > 0) {
    return Promise.all(
      [...predecessors].map(
        (pending) => pending.initialTransfer?.completion ?? pending.inFlight ?? Promise.resolve(),
      ),
    ).then(async () => {
      // A failed episode retains its observed delivery and replay budget ahead of new work.
      if (observedEntries.some((entry) => getPendingWakeCommit(context, entry))) {
        return;
      }
      await commitRequesterWake(
        context,
        observedEntries,
        generation,
        commit,
        retainOnFailure,
        stateContext,
      );
    });
  }
  const entries = observedEntries;
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...entries],
    generation,
    stateContext,
    commit,
    failures: 0,
    nextAttemptAt: 0,
    ownsRetirement: (entry) =>
      pending.committedWake?.result.applied === true &&
      pending.committedWake.result.retiredRunIds.includes(entry.runId),
    adoptPublished(members) {
      pending.entries = members.map((entry) =>
        currentSubagentRunOrObserved(context.options.runs, entry),
      );
      return pending.entries;
    },
    isCurrent: (entry) => {
      const current = context.options.runs.get(entry.runId);
      return current
        ? isSameSubagentRunOwner(current, entry) &&
            (current.requesterSettleWake?.rearmGeneration === generation ||
              (pending.committedWake !== undefined && current.requesterSettleWake === undefined))
        : pending.ownsRetirement(entry);
    },
  };
  // Sibling wakes must observe the same fence while the first worker write is
  // still settling, before a failure has established its retry deadline.
  for (const entry of entries) {
    if (pending.isCurrent(entry)) {
      context.pendingRequesterSettleWakeCommits.set(getSubagentRunRuntimeKey(entry), pending);
    }
  }
  return runPendingWakeCommit(context, pending, retainOnFailure);
}

export function retryPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): Promise<void> {
  if (pending.inFlight) {
    return pending.inFlight;
  }
  if (pending.nextAttemptAt > Date.now()) {
    return Promise.resolve();
  }
  return runPendingWakeCommit(context, pending, true);
}

function runPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
  retainOnFailure: WakeCommitFailureRetention,
): Promise<void> {
  const retain = (error?: unknown) => {
    const shouldRetain =
      typeof retainOnFailure === "function" ? retainOnFailure(error, pending) : retainOnFailure;
    if (shouldRetain) {
      deferWakeCommit(context, pending);
    } else {
      clearPendingWakeCommit(context, pending);
    }
  };
  const operation = Promise.resolve()
    .then(async () => {
      try {
        const members = pending.entries.filter(
          (member) => getPendingWakeCommit(context, member) === pending,
        );
        if (members.length === 0 || (await pending.commit(members, pending))) {
          clearPendingWakeCommit(context, pending);
        } else {
          // A temporarily closed Gateway cannot erase already observed delivery.
          retain();
        }
      } catch (error) {
        retain(error);
        throw error;
      }
    })
    .finally(() => {
      pending.inFlight = undefined;
    });
  pending.inFlight = operation;
  return operation;
}
