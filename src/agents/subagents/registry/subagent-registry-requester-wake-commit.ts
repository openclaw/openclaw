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
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryCommitReceiptError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { RequesterInitialTransfer } from "./subagent-registry-requester-yield.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  captureRequesterSettleRunIdentity,
  captureRequesterSettleWakeProgress,
  isRequesterCompletionCohortCurrent,
} from "./subagent-requester-settle-identity.js";
import {
  bindSubagentRunRuntimeKey,
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

function clearPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  pending.initialTransfer?.retire();
  if (pending.initialTransfer?.blocked) {
    return;
  }
  for (const entry of pending.entries) {
    if (
      context.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry)) === pending
    ) {
      context.pendingRequesterSettleWakeCommits.delete(getSubagentRunRuntimeKey(entry));
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
  const pending = context.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry));
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
  } catch (error) {
    return Promise.reject(new SubagentRegistryWriteError("not-committed", error));
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
      throw new SubagentRegistryWriteError("not-committed", reason);
    });
  }
  const completion = createDeferredCore();
  let entries = [...params.entries];
  const identities = new Map(
    entries.map((entry) => [entry.runId, captureRequesterSettleRunIdentity(entry)]),
  );
  const cancelled = new Map(
    entries.map((entry) => [
      entry.runId,
      {
        killIntent: entry.killIntent,
        killReconciliation: entry.killReconciliation,
        suppressed: entry.suppressCompletionDelivery,
      },
    ]),
  );
  const retiredRunIds = new Set<string>();
  let writeFailure: SubagentRegistryWriteError | undefined;
  let retired = false;
  let prepared = false;
  let promoted = false;
  let released = !params.release;
  const currentEntries = () =>
    entries.map((entry) => {
      const current = context.options.runs.get(entry.runId);
      return current && isSameSubagentRunOwner(current, entry) ? current : entry;
    });
  const initialTransfer = {
    kind: params.kind,
    completion: completion.promise,
    published: false,
    completed: false,
    blocked: false,
    retire() {
      retired = true;
      const retainsOutcome = () =>
        !initialTransfer.completed &&
        (initialTransfer.published ||
          writeFailure?.outcome === "committed" ||
          writeFailure?.outcome === "unknown");
      initialTransfer.blocked =
        !initialTransfer.completed && (pending.inFlight !== undefined || retainsOutcome());
      const finishRetirement = () => {
        initialTransfer.blocked = retainsOutcome();
        if (!initialTransfer.blocked) {
          for (const entry of entries) {
            const key = getSubagentRunRuntimeKey(entry);
            if (context.pendingRequesterSettleWakeCommits.get(key) === pending) {
              context.pendingRequesterSettleWakeCommits.delete(key);
            }
          }
        }
        if (!initialTransfer.completed) {
          const failure = writeFailure;
          completion.reject(
            failure && (failure.outcome !== "not-committed" || !initialTransfer.published)
              ? failure
              : new SubagentRegistryWriteError(
                  initialTransfer.published ? "committed" : "not-committed",
                  failure ?? new Error("Initial requester transfer lost its original owner"),
                  initialTransfer.published ? "published" : undefined,
                ),
          );
        }
      };
      if (pending.inFlight) {
        void pending.inFlight.then(finishRetirement, finishRetirement);
      } else {
        finishRetirement();
      }
    },
  };
  function assertEpisodeCurrent() {
    params.assertCurrent();
    assertSubagentRegistryWriteSourceCurrent(params.stateContext);
    if (
      retired ||
      entries.some(
        (entry) =>
          context.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry)) !==
            pending ||
          !isRequesterCompletionCohortCurrent(entry, entries, (key, matches) =>
            context.options.getLatestRunForChildSession(key, matches),
          ),
      )
    ) {
      throw new SubagentRegistryMutationRejectedError(
        "Initial requester transfer episode was superseded",
      );
    }
    for (const expected of entries) {
      const current = context.options.runs.get(expected.runId);
      if (
        retiredRunIds.has(expected.runId)
          ? current !== undefined
          : !isSameSubagentRunOwner(current, expected) ||
            !current ||
            !isDeepStrictEqual(
              captureRequesterSettleRunIdentity(current),
              identities.get(expected.runId),
            ) ||
            !isDeepStrictEqual(
              {
                killIntent: current.killIntent,
                killReconciliation: current.killReconciliation,
                suppressed: current.suppressCompletionDelivery,
              },
              cancelled.get(expected.runId),
            )
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Initial requester handoff lost its recorded cohort",
        );
      }
    }
    if (initialTransfer.published && (!params.release || !released)) {
      params.assertHandoffCurrent(currentEntries());
    }
  }
  function adoptPublished(next: readonly SubagentRunRecord[]) {
    entries = [...next];
    pending.entries = entries;
    for (const entry of entries) {
      identities.set(entry.runId, captureRequesterSettleRunIdentity(entry));
    }
    initialTransfer.published = true;
    return entries;
  }
  async function write(
    mutate: (drafts: SubagentRunRecord[]) => ReadonlySet<string> | void,
    releasing = false,
  ) {
    try {
      let publicationObserved = false;
      const result = await mutateSubagentRuns(
        entries.map((entry) => entry.runId),
        (rows) => {
          assertEpisodeCurrent();
          if (!initialTransfer.published) {
            params.validateSelection?.();
          }
          const drafts = entries.map((entry) => {
            const current = rows.get(entry.runId) ?? entry;
            const draft = structuredClone(current);
            bindSubagentRunRuntimeKey(draft, getSubagentRunRuntimeKey(current));
            return draft;
          });
          const retiring = mutate(drafts);
          const postimages = new Map<string, SubagentRunRecord | null>();
          for (const entry of drafts) {
            if (
              !retiredRunIds.has(entry.runId) &&
              (retiring?.has(entry.runId) || !isDeepStrictEqual(entry, rows.get(entry.runId)))
            ) {
              postimages.set(entry.runId, retiring?.has(entry.runId) ? null : entry);
            }
          }
          return { value: { drafts, retiring }, postimages };
        },
        {
          runs: context.options.runs,
          context: params.stateContext,
          assertCurrent: assertEpisodeCurrent,
          onPublished: (_postimages, value) => {
            publicationObserved = true;
            for (const runId of value.retiring ?? []) {
              retiredRunIds.add(runId);
            }
            if (releasing) {
              released = true;
            }
            adoptPublished(
              value.drafts.map((entry) => {
                const current = context.options.runs.get(entry.runId);
                return current && isSameSubagentRunOwner(current, entry) ? current : entry;
              }),
            );
          },
        },
      );
      if (!publicationObserved) {
        if (releasing) {
          released = true;
        }
        adoptPublished(
          result.drafts.map((entry) => {
            const current = context.options.runs.get(entry.runId);
            return current && isSameSubagentRunOwner(current, entry) ? current : entry;
          }),
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
        writeFailure instanceof SubagentRegistryCommitReceiptError
      ) {
        completion.reject(writeFailure);
        if (writeFailure.outcome !== "not-committed") {
          initialTransfer.retire();
        }
      }
      throw writeFailure;
    }
  }
  const pending: PendingRequesterSettleWakeCommit = {
    entries,
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
    ownsRetirement: (entry) => initialTransfer.published && retiredRunIds.has(entry.runId),
    adoptPublished,
    async commit() {
      if (
        writeFailure?.outcome === "unknown" ||
        writeFailure instanceof SubagentRegistryCommitReceiptError
      ) {
        throw writeFailure;
      }
      if (!prepared) {
        try {
          assertEpisodeCurrent();
          await params.prepare?.();
          assertEpisodeCurrent();
          prepared = true;
        } catch (error) {
          writeFailure = new SubagentRegistryWriteError("not-committed", error);
          completion.reject(writeFailure);
          initialTransfer.retire();
          throw writeFailure;
        }
      }
      if (!initialTransfer.published) {
        await write(params.mutate);
      }
      assertEpisodeCurrent();
      if (!promoted) {
        params.finish(currentEntries());
        promoted = true;
      }
      if (!released && params.release) {
        await write(params.release, true);
      }
      assertEpisodeCurrent();
      params.afterRelease?.(currentEntries());
      initialTransfer.completed = true;
      completion.resolve();
      return true;
    },
  };
  for (const entry of entries) {
    context.pendingRequesterSettleWakeCommits.set(getSubagentRunRuntimeKey(entry), pending);
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
    const member = currentEntries().find(
      (entry) => getPendingWakeCommit(context, entry) === pending,
    );
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
  observedEntries: readonly SubagentRunRecord[],
  generation: number | undefined,
  commit: PendingRequesterSettleWakeCommit["commit"],
  retainOnFailure: WakeCommitFailureRetention,
  retryWholeBatch = false,
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
        retryWholeBatch,
        stateContext,
      );
    });
  }
  const entries = observedEntries;
  const owners = new Map(
    entries.map((entry) => [
      getSubagentRunRuntimeKey(entry),
      {
        identity: captureRequesterSettleRunIdentity(entry),
        generation,
        progress: captureRequesterSettleWakeProgress(entry),
        killIntent: entry.killIntent,
        killReconciliation: entry.killReconciliation,
        published: false,
      },
    ]),
  );
  let acknowledgedReceipt: PendingRequesterSettleWakeCommit["committedWake"];
  const acknowledgedProgress = new Map<
    string,
    ReturnType<typeof captureRequesterSettleWakeProgress>
  >();
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...entries],
    generation,
    stateContext,
    commit,
    retryWholeBatch,
    failures: 0,
    nextAttemptAt: 0,
    ownsRetirement: (entry) => {
      const key = getSubagentRunRuntimeKey(entry);
      const committed = pending.committedWake;
      // A canonical conflict refresh may expose our deletion before its callback publishes.
      return (
        owners.has(key) &&
        !context.options.runs.has(entry.runId) &&
        committed?.result.applied === true &&
        committed.result.retiredRunIds.includes(entry.runId) &&
        committed.entries.some(({ subagent }) => isSameSubagentRunOwner(subagent, entry))
      );
    },
    adoptPublished(members) {
      const published = new Map<string, SubagentRunRecord>();
      for (const entry of members) {
        const owner = owners.get(getSubagentRunRuntimeKey(entry));
        if (!owner) {
          continue;
        }
        const current = context.options.runs.get(entry.runId);
        if (current && !isSameSubagentRunOwner(current, entry)) {
          throw new SubagentRegistryMutationRejectedError(
            "Requester wake publication lost its runtime owner",
          );
        }
        owner.published = true;
        owner.generation = current?.requesterSettleWake?.rearmGeneration;
        owner.progress = current && captureRequesterSettleWakeProgress(current);
        published.set(entry.runId, current ?? entry);
      }
      pending.entries = pending.entries.map((entry) => published.get(entry.runId) ?? entry);
      return [...published.values()];
    },
    isCurrent: (entry) => {
      const owner = owners.get(getSubagentRunRuntimeKey(entry));
      if (!owner) {
        return false;
      }
      const live = context.options.runs.get(entry.runId);
      if (!live) {
        return pending.ownsRetirement(entry);
      }
      if (
        !isSameSubagentRunOwner(live, entry) ||
        !isDeepStrictEqual(captureRequesterSettleRunIdentity(live), owner.identity) ||
        !isDeepStrictEqual(live.killIntent, owner.killIntent) ||
        !isDeepStrictEqual(live.killReconciliation, owner.killReconciliation) ||
        !isRequesterCompletionCohortCurrent(live, pending.entries, (key, matches) =>
          context.options.getLatestRunForChildSession(key, matches),
        )
      ) {
        return false;
      }
      const progress = captureRequesterSettleWakeProgress(live);
      // Canonical refresh can expose our committed state before its publication retry.
      // A different wake must leave this episode, even when a native receipt is retained.
      if (pending.committedWake && !owner.published) {
        if (acknowledgedReceipt !== pending.committedWake) {
          acknowledgedReceipt = pending.committedWake;
          acknowledgedProgress.clear();
          for (const { row } of acknowledgedReceipt.result.records) {
            const intended = rowToSubagentRunRecord(row);
            if (intended) {
              acknowledgedProgress.set(
                intended.runId,
                captureRequesterSettleWakeProgress(intended),
              );
            }
          }
        }
        if (
          acknowledgedProgress.has(entry.runId) &&
          isDeepStrictEqual(progress, acknowledgedProgress.get(entry.runId))
        ) {
          return true;
        }
      }
      const wake = live.requesterSettleWake;
      if (owner.published && !owner.progress) {
        return wake === undefined;
      }
      return Boolean(
        wake &&
        wake.rearmGeneration === owner.generation &&
        isDeepStrictEqual(progress, owner.progress),
      );
    },
  };
  // Sibling wakes must observe the same fence while the first worker write is
  // still settling, before a failure has established its retry deadline.
  for (const entry of entries) {
    if (pending.isCurrent(entry)) {
      context.pendingRequesterSettleWakeCommits.set(getSubagentRunRuntimeKey(entry), pending);
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
