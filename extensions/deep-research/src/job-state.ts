import { createHash } from "node:crypto";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { ResearchRequest, ResearchResult } from "./contract.js";
import type { ResearchExecution } from "./execution.js";
import type { ResearchAdapterSnapshot } from "./managed-contract.js";

export type ResearchJob = {
  version: 1;
  id: string;
  request: ResearchRequest;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  createdAt: number;
  deadlineAt: number;
  state:
    | "queued"
    | "running"
    | "paused"
    | "submitting"
    | "indeterminate"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed";
  progress: string;
  lifecycleRevision?: string;
  recovery?: "ready" | "unavailable" | "deferred";
  nextWakeAt?: number;
  publicationId?: string;
  publishedAt?: number;
  handle?: ResearchAdapterSnapshot["handle"];
  result?: ResearchResult;
  cancelRequested?: boolean;
  pollFailures?: number;
  /** Total interrupted authority borrows; bounded across restarts. */
  wakeFailures?: number;
};
export type RecoveryWake = Pick<ResearchJob, "id" | "agentId" | "sessionKey" | "sessionId"> & {
  nextWakeAt: number;
};
export type Step = { state: "started" } | { state: "done"; value: unknown } | { state: "failed" };
export const retentionMs = 7 * 24 * 60 * 60_000;
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const terminal = (job: ResearchJob) =>
  ["completed", "partial", "cancelled", "failed", "indeterminate"].includes(job.state);
// Optional properties are omitted at the JSON persistence boundary. Inputs and receipts
// are validated JSON data; the state store deliberately rejects explicit undefined fields.
export function retainedJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON encoding must omit undefined; structuredClone preserves fields rejected by the state store.
  return JSON.parse(JSON.stringify(value)) as T;
}
/** Feature-owned persistence bounds and namespaces; never a source of execution authority. */
export class ResearchState {
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly scheduler: PluginServiceSchedulerV1,
  ) {}
  wakes(assertCurrent = () => this.scheduler.signal.throwIfAborted()) {
    return this.api.runtime.state.openKeyedStoreV2<RecoveryWake>(
      { namespace: "research-wakes-v1", maxEntries: 4096, overflowPolicy: "reject-new" },
      { assertCurrent },
    );
  }
  open<T>(
    kind: "jobs" | "steps" | "cancellations",
    context: ResearchExecution,
    assertCurrent = context.assertInvocationCurrent,
  ) {
    if (!context.sessionKey || !context.sessionId || !context.agentId) {
      throw new Error("Research requires a current conversation generation.");
    }
    return this.api.runtime.state.openKeyedStoreV2<T>(
      {
        namespace: this.namespace(kind, context),
        maxEntries: kind === "steps" ? 4096 : 32,
        overflowPolicy: "reject-new",
      },
      { assertCurrent },
    );
  }
  private namespace(kind: "jobs" | "steps" | "cancellations", context: ResearchExecution) {
    return `research-${kind}-v1-${hash(`${context.agentId}\n${context.sessionKey}\n${context.sessionId}`)}`;
  }
  async pruneWake(id: string, assertCurrent = () => this.scheduler.signal.throwIfAborted()) {
    const wakes = this.wakes(assertCurrent);
    const observed = await wakes.observe(id);
    assertCurrent();
    if (!observed.value) {
      return;
    }
    const context = { ...observed.value, assertInvocationCurrent: assertCurrent };
    const job = await this.open<ResearchJob>("jobs", context).observe(id);
    assertCurrent();
    if (job.value && !terminal(job.value) && job.value.recovery === "ready") {
      return;
    }
    // A newer job/wake may appear across either read. Compare both records in
    // one native transaction; cleanup must never erase a renewed execution.
    await wakes.compareAndApply(
      id,
      observed.comparison,
      { operation: "delete", action: "delete" },
      {
        conditions: [
          { namespace: this.namespace("jobs", context), key: id, comparison: job.comparison },
        ],
      },
    );
    assertCurrent();
  }

  async retainStartOutcome(job: ResearchJob, handle?: ResearchAdapterSnapshot["handle"]) {
    const assertCurrent = () => this.scheduler.signal.throwIfAborted();
    const context = { ...job, assertInvocationCurrent: assertCurrent };
    const store = this.open<ResearchJob>("jobs", context);
    const observed = await store.observe(job.id);
    assertCurrent();
    const latest = observed.value;
    if (
      !latest ||
      latest.id !== job.id ||
      latest.agentId !== job.agentId ||
      latest.sessionKey !== job.sessionKey ||
      latest.sessionId !== job.sessionId ||
      latest.lifecycleRevision !== job.lifecycleRevision ||
      latest.state !== "submitting" ||
      latest.handle ||
      latest.result ||
      latest.publicationId
    ) {
      throw new Error("Research receipt no longer belongs to the pending submission.");
    }
    // Only definite submission bookkeeping may outlive the source borrow. An
    // absent handle here means proven not sent, never an unknown transport result.
    // No report, request, policy, or target is copied from the response/caller.
    if (handle) {
      latest.handle = handle;
    }
    latest.state = "paused";
    latest.progress = handle
      ? "Provider receipt recorded for reconciliation."
      : "Provider request was not sent.";
    const result = await store.compareAndApply(job.id, observed.comparison, {
      operation: "update",
      action: "set",
      value: retainedJson(latest),
      ttlMs: retentionMs,
    });
    assertCurrent();
    if (result.status === "conflict") {
      throw new Error("Research receipt raced with newer job state.");
    }
    await this.prepareWake(latest, assertCurrent);
    return latest;
  }

  async settleUnavailable(
    id: string,
    context: ResearchExecution,
    reason: string,
    retryAfterMs?: number,
  ) {
    const store = this.open<ResearchJob>("jobs", context);
    const observed = await store.observe(id);
    context.assertInvocationCurrent();
    const latest = observed.value;
    if (!latest || terminal(latest) || latest.recovery !== "ready") {
      return latest;
    }
    if (latest.state === "submitting" && !latest.handle) {
      latest.state = "indeterminate";
      latest.progress = "Submission outcome is unknown; not resubmitted.";
      delete latest.nextWakeAt;
    } else {
      recordWakeFailure(latest, this.scheduler.now(), reason, retryAfterMs);
    }
    const result = await store.compareAndApply(id, observed.comparison, {
      operation: "update",
      action: "set",
      value: latest,
      ttlMs: retentionMs,
    });
    context.assertInvocationCurrent();
    if (result.status === "conflict") {
      return result.current.value;
    }
    // A stale index remains safe across a crash: wake checks the job's due time.
    await this.prepareWake(latest, context.assertInvocationCurrent);
    await this.pruneWake(id, context.assertInvocationCurrent);
    return latest;
  }

  async prepareWake(job: ResearchJob, assertCurrent: () => void) {
    if (terminal(job) || job.recovery !== "ready") {
      return;
    }
    // Persist the wake before the job can accept external work. A crash between
    // these writes leaves only a harmless reference to a nonexistent/local job.
    await this.wakes(assertCurrent).register(
      job.id,
      {
        id: job.id,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
        sessionId: job.sessionId,
        nextWakeAt: job.nextWakeAt ?? this.scheduler.now(),
      },
      { ttlMs: retentionMs },
    );
    assertCurrent();
  }
  async retireWake(job: ResearchJob, assertCurrent: () => void) {
    if (terminal(job) || job.recovery !== "ready") {
      // Result/terminal state is committed first. A crash before this cleanup
      // can cause a local lookup, never a second submission/publication.
      await this.pruneWake(job.id, assertCurrent);
      assertCurrent();
    }
  }
}

/** Both an unavailable borrow and a definite start refusal consume the same retry budget. */
export function recordWakeFailure(
  job: ResearchJob,
  now: number,
  reason: string,
  retryAfterMs?: number,
) {
  job.wakeFailures = (job.wakeFailures ?? 0) + 1;
  job.state = "paused";
  if (retryAfterMs !== undefined && job.wakeFailures < 5) {
    job.nextWakeAt = now + Math.max(retryAfterMs, 5000 * 2 ** (job.wakeFailures - 1));
    job.progress = `Recovery awaiting fresh authority: ${reason}`;
  } else {
    job.recovery = "deferred";
    job.progress = `Recovery deferred: ${reason}`;
    delete job.nextWakeAt;
  }
}
