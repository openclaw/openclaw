type RedriveSuspendedCompletions = (requesterSessionKey: string) => Promise<unknown>;

async function redriveSuspendedCompletions(requesterSessionKey: string): Promise<unknown> {
  const { retryExpirySuspendedSubagentCompletionsForRequester } =
    await import("../subagent-completion-delivery.js");
  return await retryExpirySuspendedSubagentCompletionsForRequester(requesterSessionKey);
}

/** Releases compaction ownership before re-enqueuing completions blocked by that ownership. */
export async function releaseCompactionSessionLock(params: {
  release: () => Promise<void>;
  requesterSessionKey?: string;
  redrive?: RedriveSuspendedCompletions;
  onRedriveError: (error: unknown) => void;
}): Promise<void> {
  await params.release();
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (!requesterSessionKey) {
    return;
  }
  try {
    await (params.redrive ?? redriveSuspendedCompletions)(requesterSessionKey);
  } catch (error) {
    params.onRedriveError(error);
  }
}
