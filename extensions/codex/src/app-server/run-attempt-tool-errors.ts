export function isAuthorityResolutionOperationAbort(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return signal?.aborted === true && error === signal.reason;
}
