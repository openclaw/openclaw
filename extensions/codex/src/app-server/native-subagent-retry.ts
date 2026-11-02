export function delayForAttempt(delays: readonly number[], attempt: number): number {
  return Math.max(1, delays[Math.min(attempt, delays.length - 1)] ?? 1);
}
