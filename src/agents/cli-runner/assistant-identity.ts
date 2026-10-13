/** Recovery attempts and the final correction share the run's cumulative transcript row. */
export function cliAssistantItemId(runId: string): string {
  return `cli-assistant:${runId}`;
}
