import type { Result } from "@openclaw/normalization-core/result";

/** Settle owned work before cleanup; the caller retains its failure and commit policy. */
export async function withAuthProfileCleanup<T>(
  operation: () => Promise<T>,
  cleanup: (outcome: Result<T, unknown>) => Promise<void>,
): Promise<T> {
  let outcome: Result<T, unknown>;
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await cleanup(outcome);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
