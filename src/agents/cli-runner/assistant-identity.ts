/** Native message identity joins a pre-tool preview to its saved snapshot. */
export function cliCommentaryItemId(runId: string, messageId: string): string {
  return `commentary-${runId}-${messageId}`;
}

/** Recovery attempts and the final correction share the run's cumulative transcript row. */
export function cliAssistantItemId(runId: string): string {
  return `cli-assistant:${runId}`;
}
