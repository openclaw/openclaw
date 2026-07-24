/**
 * Build the fail-closed error used after an append backend starts but does not
 * acknowledge completion. Readback cannot attribute bytes to one writer, and
 * the backend may have persisted a prefix before rejecting.
 */
export function createUncertainAppendOutcomeError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Append outcome is uncertain; do not retry automatically. The backend did not acknowledge completion: ${detail}`,
    { cause: error },
  );
}
