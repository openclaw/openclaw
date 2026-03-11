import type { PartialExecution } from "./failover-error.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  partialExecution?: PartialExecution;
};
