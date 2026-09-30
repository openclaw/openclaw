import { isDeepStrictEqual } from "node:util";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-delivery.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  captureSubagentRunMutationSnapshot,
  captureSubagentRunPostimagePublication,
  publishSubagentRunPostimages,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { RequesterInitialTransfer } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  captureRequesterSettleRunIdentity,
  isRequesterCompletionCohortCurrent,
} from "./subagent-requester-settle-identity.js";

// Reporting thresholds never change the durable obligation or retry cadence.
const REQUESTER_SETTLE_WAKE_COMMIT_SUSTAINED_FAILURES = 5;

const REQUESTER_SETTLE_WAKE_COMMIT_MAX_BACKOFF_MS = 120_000;

// Count emitted reports separately: not every reported rejection advances commit failures.
const REQUESTER_SETTLE_WAKE_FAILURE_REPORT_BUDGET = 5;

type WakeCommitFailureRetention =
  | boolean
  | ((error: unknown, pending: PendingRequesterSettleWakeCommit) => boolean);

function clearPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  pending.initialTransfer?.retire();
  if (pending.initialTransfer?.blocked) {
    return;
  }
  for (const entry of pending.entries) {
    if (context.pendingRequesterSettleWakeCommits.get(entry) === pending) {
      context.pendingRequesterSettleWakeCommits.delete(entry);
    }
  }
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
  const pending = context.pendingRequesterSettleWakeCommits.get(entry);
  if (pending?.initialTransfer?.blocked) {
    return pending;
  }
  if (pending && !pending.isCurrent(entry)) {
    if (pending.initialTransfer) {
      clearPendingWakeCommit(context, pending);
      return pending.initialTransfer.blocked ? pending : undefined;
    }
    // A changed row relinquishes only its own obligation. Surviving siblings
    // must keep the known outcome or replay budget ahead of transport.
    context.pendingRequesterSettleWakeCommits.delete(entry);
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
    current === entry || (current === undefined && pending?.isPublishedRetirement(entry) === true)
  );
}

/** Initial intent and cohort writes retain their caller through the complete handoff. */
export function commitRequesterInitialTransfer(
  context: SubagentLifecycleWakeContext,
  params: Parameters<RequesterInitialTransfer>[0] & {
    stateContext: OpenClawStateWorkerContext;
    assertCurrent(): void;
    scheduleRetry(entry: SubagentRunRecord): void;
  },
): Promise<void> {
  try {
    params.assertCurrent();
    if (params.alreadyPublished) {
      params.assertHandoffCurrent();
    }
  } catch (error) {
    return Promise.reject(
      new SubagentRegistryWriteError(
        params.alreadyPublished ? "committed" : "not-committed",
        error,
        params.alreadyPublished ? "published" : undefined,
      ),
    );
  }
  const existing = params.entries.map((entry) => getPendingWakeCommit(context, entry));
  const existingEpisode = existing.find((pending) => pending !== undefined);
  if (existingEpisode) {
    if (
      existingEpisode.initialTransfer?.kind === params.kind &&
      existingEpisode.entries.length === params.entries.length &&
      existing.every((pending) => pending === existingEpisode)
    ) {
      return existingEpisode.initialTransfer.completion.then(() => {
        try {
          params.assertCurrent();
        } catch (error) {
          throw new SubagentRegistryWriteError("committed", error, "published");
        }
      });
    }
    const settlement =
      existingEpisode.initialTransfer?.completion ?? existingEpisode.inFlight ?? Promise.resolve();
    return settlement.then(() => {
      let reason: unknown = new Error(
        "Another requester transfer finished; this transfer was not started",
      );
      try {
        params.assertCurrent();
      } catch (error) {
        reason = error;
      }
      throw new SubagentRegistryWriteError(
        params.alreadyPublished ? "committed" : "not-committed",
        reason,
        params.alreadyPublished ? "published" : undefined,
      );
    });
  }
  const completion = createDeferredCore();
  const snapshot = () =>
    new Map(
      params.entries.map((entry) => [entry, captureSubagentRunMutationSnapshot(entry)] as const),
    );
  let previous = snapshot();
  let custody = captureSubagentRunPostimagePublication({
    runs: context.options.runs,
    previous,
    context: params.stateContext,
    assertCurrent: () => {},
    requireMutationOwnerIdentity: true,
  });
  let handoffOwners:
    | {
        entry: SubagentRunRecord;
        identity: ReturnType<typeof captureRequesterSettleRunIdentity>;
        killIntent: SubagentRunRecord["killIntent"];
        killReconciliation: SubagentRunRecord["killReconciliation"];
        suppressed: SubagentRunRecord["suppressCompletionDelivery"];
        retired: boolean;
      }[]
    | undefined;
  let writeFailure: SubagentRegistryWriteError | undefined;
  let finished = false;
  let retired = false;
  let prepared = false;
  let promoted = false;
  let released = !params.release;
  let writing = false;
  const initialTransfer = {
    kind: params.kind,
    completion: completion.promise,
    published: false,
    completed: false,
    blocked: false,
    retire() {
      retired = true;
      const retainsNativeOutcome = () =>
        initialTransfer.published ||
        writeFailure?.outcome === "committed" ||
        writeFailure?.outcome === "unknown";
      // A second claim must wait until an accepted attempt's outcome is known.
      initialTransfer.blocked =
        !finished && (pending.inFlight !== undefined || retainsNativeOutcome());
      const rejectRetired = () => {
        if (!finished) {
          initialTransfer.blocked = retainsNativeOutcome();
          if (!initialTransfer.blocked) {
            for (const entry of pending.entries) {
              if (context.pendingRequesterSettleWakeCommits.get(entry) === pending) {
                context.pendingRequesterSettleWakeCommits.delete(entry);
              }
            }
          }
          let failure = writeFailure;
          if (!failure || (failure.outcome === "not-committed" && initialTransfer.published)) {
            failure = new SubagentRegistryWriteError(
              initialTransfer.published ? "committed" : "not-committed",
              failure ?? new Error("Initial requester transfer lost its original owner"),
              initialTransfer.published ? "published" : undefined,
            );
          }
          completion.reject(failure);
        }
      };
      if (pending.inFlight) {
        // Caller retirement still joins accepted native work and its publication.
        void pending.inFlight.then(rejectRetired, rejectRetired);
      } else {
        rejectRetired();
      }
    },
  };
  function assertHandoffCurrent() {
    assertSubagentRegistryWriteSourceCurrent(params.stateContext);
    if (
      !handoffOwners ||
      handoffOwners.some(
        (owner) =>
          (owner.retired
            ? context.options.runs.has(owner.entry.runId)
            : context.options.runs.get(owner.entry.runId) !== owner.entry) ||
          !isDeepStrictEqual(captureRequesterSettleRunIdentity(owner.entry), owner.identity) ||
          owner.entry.killIntent !== owner.killIntent ||
          owner.entry.killReconciliation !== owner.killReconciliation ||
          owner.entry.suppressCompletionDelivery !== owner.suppressed,
      )
    ) {
      throw new Error("Initial requester handoff lost its recorded cohort");
    }
    if (!params.release || !released) {
      params.assertHandoffCurrent();
    }
  }
  function adoptPublished() {
    handoffOwners = params.entries.map((entry) => ({
      entry,
      identity: captureRequesterSettleRunIdentity(entry),
      killIntent: entry.killIntent,
      killReconciliation: entry.killReconciliation,
      suppressed: entry.suppressCompletionDelivery,
      retired: params.retire?.has(entry) === true,
    }));
    initialTransfer.published = true;
  }
  function assertEpisodeCurrent() {
    params.assertCurrent();
    if (
      retired ||
      params.entries.some(
        (entry) =>
          context.pendingRequesterSettleWakeCommits.get(entry) !== pending ||
          !isRequesterCompletionCohortCurrent(entry, params.entries, (key, matches) =>
            context.options.getLatestRunForChildSession(key, matches),
          ),
      )
    ) {
      throw new Error("Initial requester transfer episode was superseded");
    }
    if (initialTransfer.published && !writing) {
      assertHandoffCurrent();
    } else {
      custody.assertCurrent();
    }
  }
  async function write(mutate: () => void, onPublished: () => void) {
    assertEpisodeCurrent();
    previous = snapshot();
    custody = captureSubagentRunPostimagePublication({
      runs: context.options.runs,
      previous,
      context: params.stateContext,
      assertCurrent: () => {},
      requireMutationOwnerIdentity: true,
    });
    writing = true;
    let capturing = true;
    try {
      mutate();
      const publication = publishSubagentRunPostimages({
        runs: context.options.runs,
        previous,
        retire: params.retire,
        persist: context.options.persistAsyncOrThrow,
        context: params.stateContext,
        assertCurrent: () => {
          params.assertCurrent();
          if (!capturing) {
            assertEpisodeCurrent();
          }
        },
        // A retired caller cannot discard an ACK that still owns its target preimage.
        assertPublicationCurrent: () => custody.assertCurrent(),
        onPublished,
      });
      capturing = false;
      const result = await publication;
      if (result.publication !== "published") {
        throw new SubagentRegistryWriteError(
          "committed",
          new Error("Initial requester transfer publication was superseded"),
          "superseded",
        );
      }
      writeFailure = undefined;
    } catch (error) {
      writeFailure =
        error instanceof SubagentRegistryWriteError
          ? error
          : new SubagentRegistryWriteError("not-committed", error);
      if (
        !initialTransfer.published ||
        writeFailure.outcome === "unknown" ||
        (writeFailure.outcome === "committed" && writeFailure.publication !== "published")
      ) {
        completion.reject(writeFailure);
        if (writeFailure.outcome === "committed" || writeFailure.outcome === "unknown") {
          initialTransfer.retire();
        }
      }
      throw writeFailure;
    } finally {
      writing = false;
    }
  }
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...params.entries],
    generation: undefined,
    stateContext: params.stateContext,
    initialTransfer,
    retryWholeBatch: true,
    failures: 0,
    nextAttemptAt: 0,
    isCurrent() {
      try {
        assertEpisodeCurrent();
        return true;
      } catch {
        return false;
      }
    },
    isPublishedRetirement: (entry) =>
      initialTransfer.published && params.retire?.has(entry) === true,
    adoptPublished,
    async commit() {
      if (
        writeFailure?.outcome === "unknown" ||
        (writeFailure?.outcome === "committed" && writeFailure.publication !== "published")
      ) {
        // Canonical restore owns uncertain native outcomes; neither stage can replay them.
        throw writeFailure;
      }
      if (!prepared) {
        try {
          assertEpisodeCurrent();
          await params.prepare?.();
          assertEpisodeCurrent();
          prepared = true;
        } catch (error) {
          writeFailure = new SubagentRegistryWriteError(
            initialTransfer.published ? "committed" : "not-committed",
            error,
            initialTransfer.published ? "published" : undefined,
          );
          completion.reject(writeFailure);
          initialTransfer.retire();
          throw writeFailure;
        }
      }
      if (!initialTransfer.published) {
        await write(params.mutate, adoptPublished);
      }
      assertEpisodeCurrent();
      if (!promoted) {
        params.finish();
        promoted = true;
      }
      if (!released && params.release) {
        await write(params.release, () => {
          released = true;
          adoptPublished();
        });
      }
      assertEpisodeCurrent();
      params.afterRelease?.();
      finished = true;
      initialTransfer.completed = true;
      completion.resolve();
      return true;
    },
  };
  if (params.alreadyPublished) {
    adoptPublished();
  }
  for (const entry of params.entries) {
    context.pendingRequesterSettleWakeCommits.set(entry, pending);
  }
  void runPendingWakeCommit(
    context,
    pending,
    () =>
      initialTransfer.published ||
      writeFailure?.outcome === "unknown" ||
      writeFailure?.outcome === "committed",
    "initial",
  ).catch(() => {
    const member = params.entries.find((entry) => getPendingWakeCommit(context, entry) === pending);
    if (member) {
      params.scheduleRetry(member);
    }
  });
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
  entries: readonly SubagentRunRecord[],
  generation: number | undefined,
  commit: PendingRequesterSettleWakeCommit["commit"],
  retainOnFailure: WakeCommitFailureRetention,
  retryWholeBatch = false,
  stateContext?: OpenClawStateWorkerContext,
): Promise<void> {
  const owners = new Map(
    entries.map((entry) => [
      entry,
      {
        identity: captureRequesterSettleRunIdentity(entry),
        wake: entry.requesterSettleWake,
        wakeJson: JSON.stringify(entry.requesterSettleWake),
        deliveryGeneration: entry.delivery?.generation,
        execution: entry.execution,
        cancellation: entry.killReconciliation,
        suppressed: entry.suppressCompletionDelivery,
        published: false,
        retired: false,
      },
    ]),
  );
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...entries],
    generation,
    stateContext,
    commit,
    retryWholeBatch,
    failures: 0,
    nextAttemptAt: 0,
    isPublishedRetirement: (entry) => {
      const owner = owners.get(entry);
      return owner?.published === true && owner.retired;
    },
    adoptPublished(members) {
      for (const entry of members) {
        const owner = owners.get(entry);
        if (!owner) {
          continue;
        }
        owner.published = true;
        owner.retired =
          pending.committedWake?.result.retiredRunIds.includes(owner.identity.runId) === true;
        owner.wake = entry.requesterSettleWake;
        owner.wakeJson = JSON.stringify(owner.wake);
        owner.execution = entry.execution;
        owner.cancellation = entry.killReconciliation;
        owner.suppressed = entry.suppressCompletionDelivery;
      }
    },
    isCurrent: (entry) => {
      const owner = owners.get(entry);
      if (
        !owner ||
        !isDeepStrictEqual(captureRequesterSettleRunIdentity(entry), owner.identity) ||
        !isRequesterCompletionCohortCurrent(entry, entries, (key, matches) =>
          context.options.getLatestRunForChildSession(key, matches),
        )
      ) {
        return false;
      }
      const live = context.options.runs.get(owner.identity.runId);
      if (
        (owner.published && owner.retired ? live !== undefined : live !== entry) ||
        (!owner.published &&
          (!entry.requesterSettleWake || entry.requesterSettleWake.rearmGeneration !== generation))
      ) {
        return false;
      }
      if (
        entry.requesterSettleWake === owner.wake &&
        entry.execution === owner.execution &&
        entry.killReconciliation === owner.cancellation &&
        entry.suppressCompletionDelivery === owner.suppressed
      ) {
        return true;
      }
      // Independent blocking keeps the same closed member in its frozen wave.
      return (
        !owner.published &&
        entry.execution.status === "terminal" &&
        entry.pauseReason !== "sessions_yield" &&
        entry.suppressCompletionDelivery === true &&
        entry.delivery?.status === "failed" &&
        entry.delivery.generation === owner.deliveryGeneration &&
        JSON.stringify(entry.requesterSettleWake) === owner.wakeJson
      );
    },
  };
  // Sibling wakes must observe the same fence while the first worker write is
  // still settling, before a failure has established its retry deadline.
  for (const entry of entries) {
    if (pending.isCurrent(entry)) {
      context.pendingRequesterSettleWakeCommits.set(entry, pending);
    }
  }
  return runPendingWakeCommit(context, pending, retainOnFailure, "initial");
}

export function retryPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): Promise<void> {
  if (pending.initialTransfer?.blocked) {
    return Promise.resolve();
  }
  if (pending.inFlight) {
    return pending.inFlight;
  }
  if (pending.nextAttemptAt > Date.now()) {
    return Promise.resolve();
  }
  return runPendingWakeCommit(context, pending, true, "retry");
}

export function rearmRequesterWakeAfterCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
  entry: SubagentRunRecord,
  isSourceCurrent: () => boolean,
): void {
  if (
    pending.needsWakeContinuation &&
    isSourceCurrent() &&
    pending.isCurrent(entry) &&
    entry.requesterSettleWake &&
    getPendingWakeCommit(context, entry) === undefined
  ) {
    pending.needsWakeContinuation = false;
    context.pendingRequesterSettleWakeRearms.add(entry);
  }
}

function runPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
  retainOnFailure: WakeCommitFailureRetention,
  attempt: "initial" | "retry",
): Promise<void> {
  const retain = (error?: unknown) => {
    if (pending.initialTransfer?.blocked) {
      return;
    }
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
        // A no-wake decision belongs to its complete original batch. Storage may
        // retry it unchanged; changed membership needs a fresh sweeper decision.
        if (
          pending.retryWholeBatch &&
          !pending.committedWake &&
          members.length !== pending.entries.length
        ) {
          clearPendingWakeCommit(context, pending);
          return;
        }
        // First admission requires every captured owner, including child-generation
        // authority. Only retries can retain a known outcome for surviving members.
        if (attempt === "initial" && members.length !== pending.entries.length) {
          retain();
          return;
        }
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
