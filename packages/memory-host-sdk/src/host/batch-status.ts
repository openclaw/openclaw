const TERMINAL_FAILURE_STATES = new Set(["failed", "expired", "cancelled", "canceled"]);

type BatchStatusLike = {
  /** Provider batch id, when included in the status payload. */
  id?: string;
  /** Provider batch state such as completed, failed, expired, or cancelled. */
  status?: string;
  /** Provider file id containing successful output rows. */
  output_file_id?: string | null;
  /** Provider file id containing row-level errors. */
  error_file_id?: string | null;
};

export type BatchCompletionResult = {
  /** Provider file id containing successful output rows. */
  outputFileId: string;
  /** Optional provider file id containing row-level errors. */
  errorFileId?: string;
};

/** Extracts output/error file ids from a completed provider batch status. */
export function resolveBatchCompletionFromStatus(params: {
  provider: string;
  batchId: string;
  status: BatchStatusLike;
}): BatchCompletionResult {
  if (!params.status.output_file_id) {
    throw new Error(`${params.provider} batch ${params.batchId} completed without output file`);
  }
  return {
    outputFileId: params.status.output_file_id,
    errorFileId: params.status.error_file_id ?? undefined,
  };
}

/** Throws with provider error-file detail when the batch reached a terminal failure state. */
export async function throwIfBatchTerminalFailure(params: {
  provider: string;
  status: BatchStatusLike;
  readError: (errorFileId: string) => Promise<string | undefined>;
}): Promise<void> {
  const state = params.status.status ?? "unknown";
  if (!TERMINAL_FAILURE_STATES.has(state)) {
    return;
  }
  const detail = params.status.error_file_id
    ? await params.readError(params.status.error_file_id)
    : undefined;
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`${params.provider} batch ${params.status.id ?? "<unknown>"} ${state}${suffix}`);
}

/** Returns completed batch files now, or waits when remote.batch.wait is enabled. */
export async function resolveCompletedBatchResult(params: {
  provider: string;
  status: BatchStatusLike;
  wait: boolean;
  waitForBatch: () => Promise<BatchCompletionResult>;
}): Promise<BatchCompletionResult> {
  const batchId = params.status.id ?? "<unknown>";
  if (!params.wait && params.status.status !== "completed") {
    throw new Error(
      `${params.provider} batch ${batchId} submitted; enable remote.batch.wait to await completion`,
    );
  }
  const completed =
    params.status.status === "completed"
      ? resolveBatchCompletionFromStatus({
          provider: params.provider,
          batchId,
          status: params.status,
        })
      : await params.waitForBatch();
  if (!completed.outputFileId) {
    throw new Error(`${params.provider} batch ${batchId} completed without output file`);
  }
  return completed;
}
