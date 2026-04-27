/** Wall-clock delay for Slack monitor timing (tests spy on this). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
