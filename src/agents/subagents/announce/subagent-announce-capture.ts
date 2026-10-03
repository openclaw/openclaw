// Completion output can lag behind lifecycle state, so capture retries briefly
// before sending an empty or stale announcement.
export async function readLatestSubagentOutputWithRetryUsing<Outcome = unknown>(params: {
  sessionKey: string;
  maxWaitMs: number;
  retryIntervalMs: number;
  outcome?: Outcome;
  readSubagentOutput: (sessionKey: string, outcome?: Outcome) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const maxWaitMs = Math.max(0, Math.min(params.maxWaitMs, 15_000));
  if (!(maxWaitMs > 0)) {
    return undefined;
  }
  const deadlineAt = performance.now() + maxWaitMs;
  for (;;) {
    const result = await params.readSubagentOutput(params.sessionKey, params.outcome);
    if (result?.trim()) {
      return result;
    }
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      return result;
    }
    const sleepMs = Math.min(params.retryIntervalMs, remainingMs);
    await new Promise((resolve) => {
      setTimeout(resolve, sleepMs);
    });
  }
}

export async function captureSubagentCompletionReplyUsing(params: {
  sessionKey: string;
  waitForReply?: boolean;
  maxWaitMs: number;
  retryIntervalMs: number;
  readSubagentOutput: (sessionKey: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const immediate = await params.readSubagentOutput(params.sessionKey);
  if (immediate?.trim()) {
    return immediate;
  }
  if (params.waitForReply === false) {
    return undefined;
  }
  return await readLatestSubagentOutputWithRetryUsing(params);
}
