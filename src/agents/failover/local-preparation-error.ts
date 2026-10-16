import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { isFailoverError } from "./error.js";

export class ContextPreparationTimeoutError extends WorkerTaskError {
  constructor(cause: WorkerTaskError) {
    super(
      "Context preparation timed out locally. Please try again. If this persists, check Gateway logs for slow context reads.",
      "timeout",
      { cause },
    );
  }
}

/** A local worker-task deadline is runtime infrastructure failure, not a provider timeout. */
export function findLocalWorkerTaskTimeout(err: unknown): WorkerTaskError | undefined {
  let localTimeout: WorkerTaskError | undefined;
  for (const candidate of collectNestedErrorCandidates(err)) {
    // Failover wrappers may synthesize HTTP-like statuses; original HTTP facts still win.
    if (isFailoverError(candidate)) {
      continue;
    }
    const record = asOptionalObjectRecord(candidate);
    if (record?.status !== undefined || record?.statusCode !== undefined) {
      return undefined;
    }
    if (candidate instanceof WorkerTaskError && candidate.code === "timeout") {
      localTimeout ??= candidate;
    }
  }
  return localTimeout;
}
