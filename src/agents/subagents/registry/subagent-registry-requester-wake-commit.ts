import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { captureRequesterSettleRunIdentity } from "./subagent-requester-settle-identity.js";

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
  if (pending && !pending.isCurrent(entry)) {
    // A changed row relinquishes only its own obligation. Surviving siblings
    // must keep the known outcome or replay budget ahead of transport.
    context.pendingRequesterSettleWakeCommits.delete(entry);
    return undefined;
  }
  return pending;
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
  const owners = entries.map((entry) => ({
    entry,
    identity: captureRequesterSettleRunIdentity(entry),
    wake: entry.requesterSettleWake,
    wakeJson: JSON.stringify(entry.requesterSettleWake),
    deliveryGeneration: entry.delivery?.generation,
    execution: entry.execution,
    cancellation: entry.killReconciliation,
    suppressed: entry.suppressCompletionDelivery,
    published: false,
    retired: false,
  }));
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...entries],
    generation,
    stateContext,
    commit,
    retryWholeBatch,
    failures: 0,
    nextAttemptAt: 0,
    isPublishedRetirement: (entry) =>
      owners.some((owner) => owner.entry === entry && owner.published && owner.retired),
    adoptPublished(members) {
      for (const owner of owners) {
        if (!members.includes(owner.entry)) {
          continue;
        }
        owner.published = true;
        owner.retired =
          pending.committedWake?.result.retiredRunIds.includes(owner.identity.runId) === true;
        owner.wake = owner.entry.requesterSettleWake;
        owner.wakeJson = JSON.stringify(owner.wake);
        owner.execution = owner.entry.execution;
        owner.cancellation = owner.entry.killReconciliation;
        owner.suppressed = owner.entry.suppressCompletionDelivery;
      }
    },
    isCurrent: (current) =>
      owners.some((owner) => {
        const { entry, identity } = owner;
        if (
          current !== entry ||
          !isDeepStrictEqual(captureRequesterSettleRunIdentity(entry), identity) ||
          context.newerGenerationOwnsSession(entry)
        ) {
          return false;
        }
        const live = context.options.runs.get(identity.runId);
        if (
          (owner.published && owner.retired ? live !== undefined : live !== entry) ||
          (!owner.published &&
            (!entry.requesterSettleWake ||
              entry.requesterSettleWake.rearmGeneration !== generation))
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
      }),
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
