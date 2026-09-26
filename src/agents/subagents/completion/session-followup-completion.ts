/** Same-process custody for a followup's result across committed yield cohorts. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  assertAgentRunLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { getFollowupCohortOwner, bindFollowupCohortOwner } from "./session-followup-cohort.js";
import type {
  FollowupCohort as Cohort,
  FollowupSettlement,
  FollowupCompletionOwner,
  FollowupReply,
  FollowupRequest,
  FollowupSuccessor,
} from "./session-followup-completion.types.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sessions.followupCompletion"), () => ({
  requests: new AsyncLocalStorage<FollowupRequest>(),
  successors: new AsyncLocalStorage<FollowupSuccessor>(),
  // Logical obligations are indexed by their current physical execution only.
  executions: new Map<string, SessionFollowupCompletion>(),
}));
export function withFollowupRequest<T>(request: FollowupRequest, run: () => T): T {
  return state.requests.run(request, run);
}
export function readFollowupRequest(runId: string, targetSessionKey: string) {
  const request = state.requests.getStore();
  return request?.runId === runId && request.targetSessionKey === targetSessionKey
    ? request
    : undefined;
}
export function readFollowupSuccessor(runId: string, targetSessionKey: string) {
  const successor = state.successors.getStore();
  return successor?.runId === runId && successor.owner.request.targetSessionKey === targetSessionKey
    ? successor
    : undefined;
}

/** A weak cohort tombstone must survive revocation: missing authority is not System authority. */
export function getFollowupForCohort(entries: readonly SubagentRunRecord[]) {
  const owner = entries.length ? getFollowupCohortOwner(entries[0]!) : undefined;
  return owner && entries.every((entry) => getFollowupCohortOwner(entry) === owner)
    ? owner
    : undefined;
}
export function promoteFollowupYield(params: {
  requesterTurnRunId: string;
  entries: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
}) {
  if (params.rearmGeneration === undefined) {
    return;
  }
  state.executions
    .get(params.requesterTurnRunId)
    ?.promoteYield(params.requesterTurnRunId, params.entries, params.rearmGeneration);
}
export function withFollowupSuccessor<T>(successor: FollowupSuccessor, run: () => T): T {
  successor.assertCurrent();
  return successor.owner.request.custody.run(() => state.successors.run(successor, run));
}

export class SessionFollowupCompletion implements FollowupCompletionOwner {
  readonly request: FollowupRequest;
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private readonly lifecycleGeneration = getAgentRunLifecycleGeneration();
  private execution: {
    runId: string;
    settled: Deferred;
    yielded: boolean;
    admittedCohort?: Cohort;
  };
  private cohort?: Cohort;
  private readonly result = createDeferredCore<FollowupReply>();
  private terminal?: FollowupReply;
  private acceptedExecution = false;
  private taking = false;
  private consumed = false;
  private readonly revoked: () => void;

  private constructor(request: FollowupRequest) {
    this.request = request;
    this.execution = { runId: request.runId, settled: createDeferredCore(), yielded: false };
    this.revoked = () => this.close(new Error("Followup completion authority was revoked."));
    void this.result.promise.catch(() => {});
  }

  static bind(request: FollowupRequest, assertAdmissionCurrent?: () => void) {
    request.custody.assertCurrent();
    assertAdmissionCurrent?.();
    const owner = new SessionFollowupCompletion(request);
    state.executions.set(request.runId, owner);
    request.custody.signal.addEventListener("abort", owner.revoked, { once: true });
    if (request.custody.signal.aborted) {
      owner.revoked();
    }
    try {
      owner.assertCurrent();
      assertAdmissionCurrent?.();
      return owner;
    } catch (error) {
      owner.close(error);
      throw error;
    }
  }

  assertCurrent() {
    this.signal.throwIfAborted();
    assertAgentRunLifecycleGenerationCurrent(this.lifecycleGeneration);
    if (state.executions.get(this.execution.runId) !== this) {
      throw new Error("Followup completion owner was replaced.");
    }
    this.request.custody.assertCurrent();
  }
  get accepted() {
    return this.acceptedExecution;
  }
  markAccepted(runId: string) {
    this.assertCurrent();
    if (!this.ownsExecution(runId)) {
      throw new Error("Followup acceptance belongs to another execution.");
    }
    this.acceptedExecution = true;
  }
  finishExecution(runId: string) {
    if (!this.ownsExecution(runId)) {
      return;
    }
    this.execution.settled.resolve();
    if (this.terminal) {
      this.result.resolve(this.terminal);
    }
  }
  ownsExecution(runId: string) {
    return !this.signal.aborted && this.execution.runId === runId;
  }
  assertExecutionCurrent(runId: string): void {
    this.assertCurrent();
    if (
      this.execution.runId !== runId ||
      this.execution.yielded ||
      this.terminal ||
      !this.acceptedExecution
    ) {
      throw new Error("Followup no longer owns this accepted execution.");
    }
  }
  promoteYield(runId: string, entries: readonly SubagentRunRecord[], generation: number) {
    this.assertCurrent();
    if (
      this.execution.runId !== runId ||
      this.terminal ||
      entries.length === 0 ||
      entries.some(
        (entry) =>
          entry.requesterSessionKey !== this.request.targetSessionKey ||
          entry.requesterSettleWake?.rearmGeneration !== generation ||
          entry.requesterSettleWake.requesterYieldBatch !== true,
      )
    ) {
      throw new Error("Followup yield does not own the committed completion cohort.");
    }
    this.cohort = { entries: [...entries], generation };
    for (const entry of entries) {
      bindFollowupCohortOwner(entry, this);
    }
  }
  successor(
    entries: readonly SubagentRunRecord[],
    runId: string,
    assertBatchCurrent: () => void,
  ): FollowupSuccessor {
    const cohort =
      this.cohort ?? (this.execution.runId === runId ? this.execution.admittedCohort : undefined);
    if (
      !cohort ||
      cohort.entries.length !== entries.length ||
      !entries.every((entry) => cohort.entries.includes(entry))
    ) {
      throw new Error("Followup completion cohort was replaced.");
    }
    const assertCurrent = () => {
      this.assertCurrent();
      assertBatchCurrent();
      if (
        (this.cohort !== cohort &&
          !(this.execution.runId === runId && this.execution.admittedCohort === cohort)) ||
        entries.some(
          (entry) =>
            getFollowupCohortOwner(entry) !== this ||
            entry.requesterSettleWake?.rearmGeneration !== cohort.generation ||
            entry.killIntent ||
            entry.killReconciliation ||
            entry.suppressCompletionDelivery,
        )
      ) {
        throw new Error("Followup successor no longer owns its completion cohort.");
      }
    };
    assertCurrent();
    return { owner: this, cohort, runId, assertCurrent };
  }
  async prepareSuccessor(successor: FollowupSuccessor) {
    successor.assertCurrent();
    await this.execution.settled.promise;
    successor.assertCurrent();
    if (!this.execution.yielded || this.terminal) {
      throw new Error("Followup predecessor did not yield.");
    }
  }
  adopt(successor: FollowupSuccessor) {
    successor.assertCurrent();
    if (!this.execution.yielded || this.terminal) {
      throw new Error("Followup predecessor is not paused.");
    }
    if (this.cohort !== successor.cohort) {
      throw new Error("Followup handoff no longer permits a new execution.");
    }
    state.executions.delete(this.execution.runId);
    this.execution = {
      runId: successor.runId,
      settled: createDeferredCore(),
      yielded: false,
      admittedCohort: successor.cohort,
    };
    this.cohort = undefined;
    this.acceptedExecution = false;
    state.executions.set(successor.runId, this);
  }
  async settle(
    runId: string,
    reply: FollowupReply,
    assertExecutionCurrent?: () => void,
  ): Promise<FollowupSettlement> {
    this.assertCurrent();
    assertExecutionCurrent?.();
    if (this.execution.runId !== runId) {
      throw new Error("Followup terminal execution was replaced.");
    }
    if (reply.status === "ok" && reply.yielded && this.cohort) {
      this.execution.yielded = true;
      return { kind: "yielded" };
    }
    const result: FollowupReply =
      reply.status === "ok" && reply.yielded
        ? { status: "error", error: "Followup yielded without a committed completion handoff." }
        : reply;
    if (!buildAgentRunTerminalOutcomeFromWaitResult(result)) {
      throw new Error("Followup execution has no terminal outcome.");
    }
    this.terminal ??= result;
    return { kind: "terminal", reply: this.terminal };
  }
  /** A timeout transfers observation, not result consumption. No second observer is launched. */
  async take(timeoutMs?: number): Promise<FollowupReply | undefined> {
    this.assertCurrent();
    if (this.consumed || this.taking) {
      throw new Error("Followup result already has a consumer.");
    }
    this.taking = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply =
        timeoutMs === undefined
          ? await this.result.promise
          : await Promise.race([
              this.result.promise,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
              }),
            ]);
      this.assertCurrent();
      if (reply) {
        this.consumed = true;
      }
      return reply;
    } finally {
      clearTimeout(timer);
      this.taking = false;
    }
  }
  replaceCohortEntry(previous: SubagentRunRecord, next: SubagentRunRecord): () => void {
    const cohorts = [this.cohort, this.execution.admittedCohort].filter(
      (cohort): cohort is Cohort => Boolean(cohort?.entries.includes(previous)),
    );
    if (
      (previous.taskRunId ?? previous.runId) !== (next.taskRunId ?? next.runId) ||
      previous.childSessionKey !== next.childSessionKey ||
      previous.requesterSessionKey !== next.requesterSessionKey ||
      previous.requesterAgentId !== next.requesterAgentId ||
      !next.requesterSettleWake
    ) {
      return () => {};
    }
    const changes = cohorts.map((cohort) => {
      const before = cohort.entries;
      const after = before.map((entry) => (entry === previous ? next : entry));
      cohort.entries = after;
      return { cohort, before, after };
    });
    return () => {
      for (const { cohort, before, after } of changes) {
        if (cohort.entries === after) {
          cohort.entries = before;
        }
      }
    };
  }
  close(error?: unknown) {
    if (this.signal.aborted) {
      return;
    }
    this.lifetime.abort(error ?? new Error("Followup completion custody ended."));
    if (state.executions.get(this.execution.runId) === this) {
      state.executions.delete(this.execution.runId);
    }
    this.execution.settled.resolve();
    this.result.reject(error ?? new Error("Followup completion custody ended."));
    this.request.custody.signal.removeEventListener("abort", this.revoked);
    this.request.custody.release();
  }
}

registerAgentEventLifecycleRotationHandler("session-followup-completions", () => {
  const failures: unknown[] = [];
  const retainedOwners = [...state.executions.values()];
  for (const owner of retainedOwners) {
    try {
      owner.assertCurrent();
    } catch (reason) {
      try {
        owner.close(reason);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to release retired followup custody");
  }
});
