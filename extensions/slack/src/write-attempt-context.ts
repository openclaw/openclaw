export type SlackWriteAttemptAuthority = Readonly<{
  assertAuthorized?: () => void;
  signal?: AbortSignal;
}>;

export function assertSlackWriteAttemptAuthorized(authority?: SlackWriteAttemptAuthority): void {
  authority?.signal?.throwIfAborted();
  authority?.assertAuthorized?.();
}

export function resolveSlackWriteAttemptSignal(
  authority?: SlackWriteAttemptAuthority,
  signal?: AbortSignal,
): AbortSignal | undefined {
  const authoritySignal = authority?.signal;
  if (!authoritySignal || authoritySignal === signal) {
    return signal ?? authoritySignal;
  }
  return signal ? AbortSignal.any([signal, authoritySignal]) : authoritySignal;
}
