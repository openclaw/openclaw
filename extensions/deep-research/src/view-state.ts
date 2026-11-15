import type { ResearchExecution } from "./execution.js";
import {
  retainedJson,
  retentionMs,
  terminal,
  type ResearchJob,
  type ResearchState,
} from "./job-state.js";

function belongs(job: ResearchJob, context: ResearchExecution) {
  return (
    job.sessionKey === context.sessionKey &&
    job.sessionId === context.sessionId &&
    job.lifecycleRevision === context.lifecycleRevision &&
    job.agentId === context.agentId
  );
}

export function assertResearchJobCurrent(
  job: ResearchJob | undefined,
  context: ResearchExecution,
): asserts job is ResearchJob {
  context.assertInvocationCurrent();
  if (!job || !belongs(job, context)) {
    throw new Error("Research job not found in this conversation generation.");
  }
}

/** Pure local reads; never recover jobs or poll providers. Caller assertions remain live. */
export async function listResearchJobs(state: ResearchState, context: ResearchExecution) {
  const entries = await state.open<ResearchJob>("jobs", context).entries();
  context.assertInvocationCurrent();
  return entries
    .map((entry) => entry.value)
    .filter((job) => belongs(job, context))
    .toSorted((a, b) => b.createdAt - a.createdAt);
}
/** Pure local read. Recovery and provider polling belong to the service. */
export async function readResearchJob(
  state: ResearchState,
  id: string,
  context: ResearchExecution,
) {
  const job = await state.open<ResearchJob>("jobs", context).lookup(id);
  assertResearchJobCurrent(job, context);
  const cancelled = await state.open<boolean>("cancellations", context).lookup(id);
  context.assertInvocationCurrent();
  return cancelled ? { ...job, cancelRequested: true } : job;
}

/** Persist an explicit user wake before the service schedules current-authority work. */
export async function requestResearchWake(
  state: ResearchState,
  id: string,
  context: ResearchExecution,
  now: number,
  cancelRequested: boolean,
) {
  const store = state.open<ResearchJob>("jobs", context);
  const observed = await store.observe(id);
  assertResearchJobCurrent(observed.value, context);
  if (terminal(observed.value)) {
    return observed.value;
  }
  const next: ResearchJob = {
    ...observed.value,
    recovery: "ready",
    wakeFailures: 0,
    pollFailures: 0,
    nextWakeAt: now,
    updatedAt: now,
    ...(cancelRequested ? { cancelRequested: true } : {}),
  };
  // A renewed job must remain discoverable if the service stops after its CAS.
  // A wake left by a failed CAS is harmless: recovery rechecks the current job.
  await state.prepareWake(next, context.assertInvocationCurrent);
  const saved = await store.compareAndApply(id, observed.comparison, {
    operation: "update",
    action: "set",
    value: retainedJson(next),
    ttlMs: retentionMs,
  });
  const current = saved.status === "conflict" ? saved.current.value : next;
  assertResearchJobCurrent(current, context);
  if (
    !terminal(current) &&
    (current.recovery !== "ready" || (current.nextWakeAt ?? Infinity) > now)
  ) {
    throw new Error("Research changed while requesting control. Refresh and retry.");
  }
  await state.prepareWake(current, context.assertInvocationCurrent);
  return current;
}
