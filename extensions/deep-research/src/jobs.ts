import { isDeepStrictEqual } from "node:util";
import type {
  OpenClawPluginApi,
  PluginServiceSchedulerV1,
  PluginServiceSessionWorkV1,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ResearchRequest } from "./contract.js";
import { renderResearchReport } from "./evidence.js";
import type { ResearchExecution } from "./execution.js";
import {
  ResearchState,
  recordWakeFailure,
  hash,
  retentionMs,
  terminal,
  retainedJson,
  type ResearchJob,
  type Step,
} from "./job-state.js";
import type { ResearchAdapterSnapshot } from "./managed-contract.js";
import {
  assertManagedRequest,
  managedClient,
  managedResult,
  reconcileManaged,
  recordManagedPollFailure,
} from "./managed.js";

export type { ResearchJob } from "./job-state.js";
export type ResearchMemo = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/** One feature service owns durable jobs, wakes, cancellation and report publication. */
export class ResearchJobs {
  private readonly state: ResearchState;
  private readonly active = new Map<string, AbortController>();
  // Local slot notification only. Durable wake records remain the restart owner;
  // each reactivated ID must reacquire current source authority.
  private readonly capacityWaiters = new Set<string>();
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly scheduler: PluginServiceSchedulerV1,
    private readonly sessionWork?: PluginServiceSessionWorkV1,
  ) {
    this.state = new ResearchState(api, scheduler);
  }
  private async readRecoveryJob(id: string) {
    const wake = await this.state.wakes().lookup(id);
    this.scheduler.signal.throwIfAborted();
    if (!wake) {
      return undefined;
    }
    // Index fields locate local data only; sessionWork.run must separately issue
    // genuinely current host authority before any model/provider/tool effect.
    const context: ResearchExecution = {
      agentId: wake.agentId,
      sessionKey: wake.sessionKey,
      sessionId: wake.sessionId,
      assertInvocationCurrent: () => this.scheduler.signal.throwIfAborted(),
    };
    const job = await this.state.open<ResearchJob>("jobs", context).lookup(id);
    context.assertInvocationCurrent();
    return job &&
      job.id === id &&
      job.agentId === wake.agentId &&
      job.sessionKey === wake.sessionKey &&
      job.sessionId === wake.sessionId
      ? { job, context }
      : undefined;
  }
  async startRecovery() {
    // Scan bounded references, never every retained report or another caller's data.
    for (const { value } of await this.state.wakes().entries()) {
      this.scheduler.signal.throwIfAborted();
      this.enqueue(value.id, value.nextWakeAt);
    }
  }
  private enqueue(id: string, nextWakeAt: number) {
    if (!this.sessionWork || this.scheduler.signal.aborted || this.active.has(id)) {
      return;
    }
    this.scheduler.schedule({
      id: `research-wake:${id}`,
      atMs: Math.max(this.scheduler.now() + 1000, nextWakeAt),
      mode: "earliest",
      run: () => this.wake(id),
    });
  }
  private schedule(job: ResearchJob) {
    if (!terminal(job) && job.recovery === "ready") {
      this.enqueue(job.id, job.nextWakeAt ?? this.scheduler.now());
    }
  }
  private async wake(id: string) {
    if (!this.sessionWork || this.active.has(id)) {
      return;
    }
    const retained = await this.readRecoveryJob(id);
    // A foreground invocation can claim the same job during the state reads.
    // Its finally owns scheduling after the slot settles.
    if (this.active.has(id)) {
      return;
    }
    const stored = retained?.job;
    if (!stored || terminal(stored) || stored.recovery !== "ready") {
      await this.state.pruneWake(id);
      return;
    }
    if ((stored.nextWakeAt ?? 0) > this.scheduler.now()) {
      this.schedule(stored);
      return;
    }
    if (this.active.size >= 4) {
      this.capacityWaiters.add(id);
      return;
    }
    try {
      const outcome = await this.sessionWork.run(id, async (current) => {
        const execution: ResearchExecution = {
          ...current.target,
          assertInvocationCurrent: current.assertCurrent,
        };
        const job = await this.get(id, execution);
        current.assertCurrent();
        return this.run(job, execution, current.signal);
      });
      this.scheduler.signal.throwIfAborted();
      if (outcome.status === "unavailable") {
        await this.defer(id, outcome.reason, outcome.retryAfterMs);
      }
    } catch {
      this.scheduler.signal.throwIfAborted();
      await this.defer(id, "Current source authority or execution became unavailable", 5000);
    }
  }
  private async defer(id: string, reason: string, retryAfterMs?: number) {
    const retained = await this.readRecoveryJob(id);
    if (!retained || this.active.has(id)) {
      return;
    }
    const latest = await this.state.settleUnavailable(id, retained.context, reason, retryAfterMs);
    if (latest) {
      this.schedule(latest);
    }
  }

  async get(id: string, context: ResearchExecution) {
    const store = this.state.open<ResearchJob>("jobs", context);
    const job = await store.lookup(id);
    context.assertInvocationCurrent();
    if (
      !job ||
      job.sessionKey !== context.sessionKey ||
      job.sessionId !== context.sessionId ||
      job.agentId !== context.agentId
    ) {
      throw new Error("Research job not found in this conversation generation.");
    }
    if (!this.active.has(id) && ["running", "submitting"].includes(job.state)) {
      job.state = job.state === "submitting" && !job.handle ? "indeterminate" : "paused";
      job.progress =
        job.state === "indeterminate"
          ? "Submission outcome is unknown; not resubmitted."
          : "Recovering the recorded job without another submission.";
      if (terminal(job)) {
        delete job.nextWakeAt;
      }
      await store.register(id, job, { ttlMs: retentionMs });
      await this.state.retireWake(job, context.assertInvocationCurrent);
    }
    return job;
  }
  async start(
    request: ResearchRequest,
    key: string,
    context: ResearchExecution,
    signal?: AbortSignal,
    progress?: (message: string) => void,
  ) {
    context.assertInvocationCurrent();
    if (!context.sessionKey || !context.sessionId || !context.agentId) {
      throw new Error("Research requires a current conversation generation.");
    }
    if (request.engine === "google") {
      assertManagedRequest(request);
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 262_144) {
      throw new Error("Research request exceeds the retained input limit.");
    }
    const id = hash(`${context.agentId}\n${context.sessionKey}\n${context.sessionId}\n${key}`);
    const store = this.state.open<ResearchJob>("jobs", context);
    const prior = await store.lookup(id);
    context.assertInvocationCurrent();
    if (prior) {
      const existing = await this.get(id, context);
      if (!isDeepStrictEqual(existing.request, retainedJson(request))) {
        throw new Error("Idempotency key belongs to a different research request.");
      }
      await this.state.prepareWake(existing, context.assertInvocationCurrent);
      this.schedule(existing);
      return existing;
    }
    if ((await store.count()) >= 32) {
      throw new Error("Research job capacity reached for this conversation.");
    }
    context.assertInvocationCurrent();
    const webEnabled = request.sources?.web ?? !request.sources?.documents?.length;
    const delegatedTools =
      request.engine === "google"
        ? []
        : [
            ...(webEnabled ? ["web_search"] : []),
            ...(webEnabled || request.sources?.urls?.length ? ["web_fetch"] : []),
          ];
    const admission = this.sessionWork
      ? await this.sessionWork.admit({
          id,
          agentId: context.agentId,
          sessionKey: context.sessionKey,
          toolName: "deep_research",
          ...(delegatedTools.length ? { delegatedTools } : {}),
        })
      : undefined;
    context.assertInvocationCurrent();
    if (admission && admission.target.sessionId !== context.sessionId) {
      throw new Error("Research conversation changed during admission");
    }
    const job: ResearchJob = {
      version: 1,
      id,
      request,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      agentId: context.agentId,
      createdAt: this.scheduler.now(),
      // Start the portable wall-clock budget only when an execution slot is admitted.
      deadlineAt: 0,
      state: "queued",
      progress: "Accepted",
      ...(admission
        ? {
            recovery: admission.recoverable ? ("ready" as const) : ("unavailable" as const),
            lifecycleRevision: admission.target.lifecycleRevision,
            nextWakeAt: this.scheduler.now(),
          }
        : {}),
    };
    await this.state.prepareWake(job, context.assertInvocationCurrent);
    if (!(await store.registerIfAbsent(id, retainedJson(job), { ttlMs: retentionMs }))) {
      const existing = await this.get(id, context);
      if (!isDeepStrictEqual(existing.request, retainedJson(request))) {
        throw new Error("Idempotency key belongs to a different research request.");
      }
      return existing;
    }
    this.schedule(job);
    return this.run(job, context, signal, progress);
  }
  async cancel(job: ResearchJob, context: ResearchExecution, signal?: AbortSignal) {
    if (terminal(job)) {
      return job;
    }
    await this.state.open<boolean>("cancellations", context).register(job.id, true, {
      ttlMs: retentionMs,
    });
    context.assertInvocationCurrent();
    this.schedule(job);
    const active = this.active.get(job.id);
    if (active) {
      active.abort(new Error("Research cancellation requested"));
      return { ...job, cancelRequested: true };
    }
    return this.run({ ...job, cancelRequested: true }, context, signal);
  }
  async run(
    initialJob: ResearchJob,
    context: ResearchExecution,
    parentSignal?: AbortSignal,
    progress: (message: string) => void = () => {},
  ) {
    let job = initialJob;
    if (terminal(job) || this.active.has(job.id)) {
      return job;
    }
    if (this.active.size >= 4) {
      // Source admission yields; a foreground invocation can take the last slot
      // after wake's precheck. Reactivate the durable job when a slot settles.
      if (job.recovery === "ready") {
        this.capacityWaiters.add(job.id);
      }
      return {
        ...job,
        progress: "Four research invocations are active; this job remains queued.",
      };
    }
    const cancel = new AbortController();
    const invocationSignal = AbortSignal.any([
      this.scheduler.signal,
      ...(parentSignal ? [parentSignal] : []),
    ]);
    const signal = AbortSignal.any([invocationSignal, cancel.signal]);
    const assertCurrent = () => {
      invocationSignal.throwIfAborted();
      context.assertInvocationCurrent();
    };
    const store = this.state.open<ResearchJob>("jobs", context, assertCurrent);
    const prepareSave = () => {
      if (terminal(job)) {
        delete job.nextWakeAt;
        if (job.result && !job.publicationId) {
          job.publicationId = job.id;
          job.publishedAt = this.scheduler.now();
        }
      } else if (job.recovery === "ready") {
        job.nextWakeAt = Math.max(this.scheduler.now() + 5000, job.nextWakeAt ?? 0);
      }
    };
    const save = async () => {
      assertCurrent();
      prepareSave();
      await this.state.prepareWake(job, assertCurrent);
      await store.register(job.id, retainedJson(job), { ttlMs: retentionMs });
      assertCurrent();
      await this.state.retireWake(job, assertCurrent);
      this.schedule(job);
    };
    // Record parent-only interruption progress while source/service authority is
    // still live. Receipt-only custody is separate and cannot publish content.
    const saveStoppedInvocation = async () => {
      const assertReceiptCurrent = () => {
        this.scheduler.signal.throwIfAborted();
        context.assertInvocationCurrent();
      };
      assertReceiptCurrent();
      prepareSave();
      await this.state.prepareWake(job, assertReceiptCurrent);
      await this.state
        .open<ResearchJob>("jobs", context, assertReceiptCurrent)
        .register(job.id, retainedJson(job), { ttlMs: retentionMs });
      assertReceiptCurrent();
      await this.state.retireWake(job, assertReceiptCurrent);
    };
    let currentJobRead = false;
    let receiptPersistenceFailed = false;
    let startPrepared = false;
    let startDispatched = false;
    let uncertain = false;
    let replayOnly = false;
    const steps = this.state.open<Step>("steps", context, assertCurrent);
    const memo: ResearchMemo = async <T>(key: string, work: () => Promise<T>) => {
      assertCurrent();
      signal.throwIfAborted();
      const stepId = `${job.id}:${hash(key)}`;
      const existing = await steps.lookup(stepId);
      assertCurrent();
      signal.throwIfAborted();
      if (existing?.state === "done") {
        return existing.value as T;
      } // This namespace is written only by this operation's typed producer.
      if (existing?.state === "started") {
        uncertain = true;
        throw new Error("Interrupted operation has no recorded receipt; not repeated.");
      }
      if (existing?.state === "failed") {
        throw new Error("A prior operation failed and will not be repeated automatically.");
      }
      if (replayOnly || this.scheduler.now() >= job.deadlineAt) {
        throw new Error("Research deadline exhausted; only recorded receipts may be replayed.");
      }
      await steps.register(stepId, { state: "started" }, { ttlMs: retentionMs });
      assertCurrent();
      signal.throwIfAborted();
      try {
        const value = await work();
        assertCurrent();
        await steps.register(stepId, retainedJson({ state: "done" as const, value }), {
          ttlMs: retentionMs,
        });
        return value;
      } catch (error) {
        assertCurrent();
        if (!signal.aborted) {
          await steps.register(stepId, { state: "failed" }, { ttlMs: retentionMs });
        }
        throw error;
      }
    };
    this.active.set(job.id, cancel);
    try {
      assertCurrent();
      // A resume may have read before another invocation finished. Own the active slot,
      // then consume the latest receipt before any submission or paid operation.
      job = await this.get(job.id, context);
      currentJobRead = true;
      // This slot is newly acquired. A prior owner may have stopped after
      // dispatch but before recording its outcome; get() sees our active slot
      // and cannot distinguish that interrupted submission from live work.
      if (job.state === "submitting" && !job.handle) {
        job.state = "indeterminate";
        job.progress = "Submission outcome is unknown; not resubmitted.";
        await save();
      }
      if (terminal(job)) {
        return job;
      }
      job.cancelRequested =
        (await this.state.open<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
        job.cancelRequested ??
        false;
      if (job.request.engine === "google") {
        const client = managedClient(this.api, context, {
          dispatched: () => {
            startDispatched = true;
          },
          retainOutcome: async (receipt) => {
            try {
              job = await this.state.retainStartOutcome(job, receipt);
            } catch (error) {
              receiptPersistenceFailed = true;
              throw error;
            }
          },
        });
        if (!job.handle && !job.cancelRequested) {
          const descriptor = await client({ version: 1, action: "describe" }, invocationSignal);
          if (!descriptor.ok) {
            recordWakeFailure(
              job,
              this.scheduler.now(),
              descriptor.reason,
              descriptor.retryAfterMs,
            );
            await save();
            return job;
          }
          if (!("kind" in descriptor.value) || descriptor.value.kind !== "managed-research") {
            throw new Error("No explicitly activated managed research adapter is available.");
          }
          // Only this run's preparation can prove a start was never dispatched.
          // A caller's stale submitting snapshot is not such proof.
          startPrepared = true;
          job.state = "submitting";
          job.progress = "Submitting managed research";
          await save();
          job.cancelRequested =
            (await this.state
              .open<boolean>("cancellations", context, assertCurrent)
              .lookup(job.id)) ?? job.cancelRequested;
          assertCurrent();
          if (job.cancelRequested || cancel.signal.aborted) {
            job.state = "cancelled";
            job.progress = "Cancelled before submission";
            await save();
            return job;
          }
          // Receipt custody requires an actual transport response and a live
          // service owner. Source retirement still fences continued work/report
          // delivery; transport loss or service shutdown can leave outcome unknown.
          invocationSignal.throwIfAborted();
          const response = await client(
            {
              version: 1,
              action: "start",
              question: job.request.question,
              ...(job.request.output === undefined ? {} : { output: job.request.output }),
              ...(job.request.asOf === undefined ? {} : { asOf: job.request.asOf }),
            },
            this.scheduler.signal,
          );
          if (parentSignal?.aborted) {
            job.state =
              job.handle || (!response.ok && response.state === "blocked")
                ? "paused"
                : "indeterminate";
            job.progress = job.handle
              ? "Invocation stopped after submission; resume or cancel the retained provider job."
              : job.state === "paused"
                ? "Provider did not accept the request; resume with fresh authority."
                : "Submission outcome is unknown; do not repeat it.";
            await saveStoppedInvocation();
            parentSignal.throwIfAborted();
          }
          if (!response.ok) {
            job.handle = response.handle;
            job.state = response.handle
              ? "paused"
              : response.state === "indeterminate"
                ? "indeterminate"
                : response.state === "blocked"
                  ? "paused"
                  : "failed";
            job.progress = response.reason;
            if (response.state === "blocked") {
              recordWakeFailure(job, this.scheduler.now(), response.reason, response.retryAfterMs);
            }
            await save();
            return job;
          }
          if (!("state" in response.value)) {
            throw new Error("Adapter returned a descriptor instead of a research receipt.");
          }
          job.handle = response.value.handle;
          assertCurrent(); // The receipt is already retained; honor parent abort before more work.
          if (response.value.state !== "running") {
            return await this.finishManaged(job, response.value, save);
          }
        }
        if (!job.handle) {
          job.state = "cancelled";
          job.progress = "Cancelled before submission";
          await save();
          return job;
        }
        assertCurrent();
        job.cancelRequested =
          (await this.state
            .open<boolean>("cancellations", context, assertCurrent)
            .lookup(job.id)) ??
          job.cancelRequested ??
          false;
        const response = await reconcileManaged(
          client,
          job.handle,
          job.cancelRequested,
          invocationSignal,
        );
        if (!response.ok) {
          recordManagedPollFailure(job, response, this.scheduler.now());
        } else {
          delete job.pollFailures;
          if (!("state" in response.value)) {
            throw new Error("Expected a research snapshot.");
          }
          if (response.value.state !== "running") {
            return await this.finishManaged(job, response.value, save);
          }
          signal.throwIfAborted();
          job.state = "paused";
          job.nextWakeAt = this.scheduler.now() + (response.value.retryAfterMs ?? 5000);
          job.progress = job.cancelRequested
            ? "Provider cancellation is not confirmed; reconciliation is pending."
            : "Provider research is running";
        }
        // One bounded step per invocation. The retained wake owns all further
        // polling/backoff; there is no second foreground timer or retry budget.
        await save();
        progress(job.progress);
        return job;
      }
      if (job.cancelRequested) {
        job.state = "cancelled";
        job.progress = "Cancelled";
        await save();
        return job;
      }
      if (!job.deadlineAt) {
        job.deadlineAt = this.scheduler.now() + (job.request.budget?.durationMs ?? 180_000);
      }
      const remaining = job.deadlineAt - this.scheduler.now();
      replayOnly = remaining <= 0;
      job.state = "running";
      job.progress = "Researching";
      await save();
      const { executePortableResearch } = await import("./portable-tool.js");
      const result = await executePortableResearch(
        this.api,
        context,
        {
          ...job.request,
          budget: {
            ...job.request.budget,
            // Expired jobs replay bounded local receipts; memo admits no new effects.
            durationMs: replayOnly ? 10_000 : remaining,
          },
        },
        signal,
        progress,
        memo,
      );
      assertCurrent();
      job.cancelRequested =
        (await this.state.open<boolean>("cancellations", context, assertCurrent).lookup(job.id)) ??
        job.cancelRequested ??
        false;
      if (replayOnly) {
        result.status = "partial";
        result.gaps.push(
          "Global research deadline exhausted; only recorded evidence was replayed, with no new calls.",
        );
        result.report = renderResearchReport(
          job.request.question,
          result.findings,
          result.sources,
          result.gaps,
        );
      }
      job.result = job.cancelRequested ? { ...result, status: "cancelled" } : result;
      job.state = uncertain ? "indeterminate" : job.result.status;
      job.progress = uncertain
        ? "Interrupted operation was not repeated; available evidence is partial."
        : "Report ready";
      await save();
      return job;
    } catch (error) {
      if (!currentJobRead || receiptPersistenceFailed || job.state === "indeterminate") {
        // A caller snapshot is not current write state. Never overwrite from it,
        // downgrade an unknown submission after settlement fails, or replace a
        // newer row after a failed receipt write. Recovery rereads durable state.
        throw error;
      }
      if (
        startPrepared &&
        job.request.engine === "google" &&
        job.state === "submitting" &&
        !startDispatched
      ) {
        // This invocation never entered the RPC. Preserve that fact even when
        // its source borrow closed after the submitting write. A crash with no
        // such proof still leaves the durable row indeterminate, never retried.
        job = await this.state.retainStartOutcome(job);
      }
      assertCurrent();
      if (cancel.signal.aborted && job.request.engine === "google" && job.handle) {
        const response = await reconcileManaged(
          managedClient(this.api, context),
          job.handle,
          true,
          invocationSignal,
        );
        if (response.ok && "state" in response.value && response.value.state !== "running") {
          return await this.finishManaged(job, response.value, save);
        }
        job.state = "paused";
        job.progress =
          "Cancellation requested; provider termination is not confirmed. Reconciliation is pending.";
        await save();
        return job;
      }
      job.state =
        job.request.engine === "google"
          ? job.state === "submitting" && !job.handle
            ? "indeterminate"
            : "paused"
          : cancel.signal.aborted
            ? "cancelled"
            : "failed";
      job.progress =
        job.state === "indeterminate"
          ? "Submission outcome is unknown; do not repeat it."
          : "Research interrupted; inspect the retained state before resuming.";
      await save();
      if (cancel.signal.aborted) {
        return job;
      }
      throw error;
    } finally {
      this.active.delete(job.id);
      this.schedule(job);
      // Drain all IDs: a selected wake may be obsolete or deferred and never
      // claim a slot. The normal wake path rechecks its durable retry deadline.
      const waiting = [...this.capacityWaiters];
      this.capacityWaiters.clear();
      for (const id of waiting) {
        this.enqueue(id, this.scheduler.now());
      }
    }
  }
  private async finishManaged(
    job: ResearchJob,
    snapshot: ResearchAdapterSnapshot,
    save: () => Promise<void>,
  ) {
    job.handle = snapshot.handle;
    job.result = managedResult(snapshot);
    job.state =
      snapshot.state === "completed" ||
      snapshot.state === "cancelled" ||
      snapshot.state === "partial"
        ? snapshot.state
        : snapshot.state === "indeterminate"
          ? "indeterminate"
          : "failed";
    job.progress = snapshot.reason ?? "Provider report ready";
    await save();
    return job;
  }
}
