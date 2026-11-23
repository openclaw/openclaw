/** Recovery attempts and the final correction share the run's cumulative transcript row. */
export function cliAssistantItemId(runId: string): string {
  return `cli-assistant:${runId}`;
}

/** Completed native answers retain the same key for deduplication and transcript retries. */
export function cliInterimAssistantItemId(
  runId: string,
  nativeIdentity: { cliSessionId: string; externalId: string },
): string {
  return `${cliAssistantItemId(runId)}:interim:${nativeIdentity.cliSessionId}:${nativeIdentity.externalId}`;
}
