import type { WorkflowJobRecord, WorkflowRetryPolicy } from "./job-types.js";

export const DEFAULT_WORKFLOW_RETRY_POLICY: WorkflowRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

export function computeRetryDelayMs(params: {
  attempt: number;
  policy?: WorkflowRetryPolicy;
  random?: () => number;
}): number {
  const policy = params.policy ?? DEFAULT_WORKFLOW_RETRY_POLICY;
  const random = params.random ?? Math.random;
  const boundedAttempt = Math.max(1, params.attempt);
  const expDelay = policy.baseDelayMs * 2 ** (boundedAttempt - 1);
  const capped = Math.min(expDelay, policy.maxDelayMs);
  const jitterBand = Math.floor(capped * policy.jitterRatio);
  if (jitterBand <= 0) {
    return capped;
  }
  const jitter = Math.floor((random() * 2 - 1) * jitterBand);
  return Math.max(0, capped + jitter);
}

export function shouldRetryJob(params: {
  job: WorkflowJobRecord;
  policy?: WorkflowRetryPolicy;
}): boolean {
  const policy = params.policy ?? DEFAULT_WORKFLOW_RETRY_POLICY;
  return params.job.attempts < policy.maxAttempts;
}

