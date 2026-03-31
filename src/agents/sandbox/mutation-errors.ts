const PYTHON3_MISSING_RE = /\bpython3:\s*not found\b/i;

/**
 * Provide actionable guidance when mutation helpers fail because the sandbox image
 * is missing Python. This keeps write/edit errors from surfacing as opaque shell
 * stderr blobs.
 */
export function toFriendlySandboxMutationError(error: unknown): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (!PYTHON3_MISSING_RE.test(rawMessage)) {
    return error instanceof Error ? error : new Error(rawMessage);
  }
  return new Error(
    "Sandbox write/edit requires `python3` inside the sandbox container, but it is missing in the active image. Rebuild or update the sandbox image (or configure a custom sandbox image that includes `python3`). Original error: " +
      rawMessage,
  );
}
