export function isSandboxKeyringQuotaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /create keyring/iu.test(error.message) &&
    /disk quota exceeded|\bEDQUOT\b/iu.test(error.message)
  );
}

export function sandboxKeyringQuotaError(cause: unknown): Error {
  return new Error(
    "Sandbox cannot start: the container engine host's per-user kernel keyring quota is exhausted. Ask the host operator to raise sysctl kernel.keys.maxkeys=2000 and kernel.keys.maxbytes=200000, persist both in /etc/sysctl.d, or reduce running sandboxes, then retry.",
    { cause },
  );
}
