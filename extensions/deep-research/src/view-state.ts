import type { ResearchExecution } from "./execution.js";
import type { ResearchJob, ResearchState } from "./job-state.js";

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
