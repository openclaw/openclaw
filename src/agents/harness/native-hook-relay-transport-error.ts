/**
 * Terminal relay-transport error shared by the parent relay and the cold CLI.
 *
 * Deliberately import-free: the native relay CLI is a cold process whose import
 * boundary forbids reaching process-global relay state, so the predicate the CLI
 * needs cannot live next to the accounting that uses it.
 */

/** Raised once a relay's transport is declared dead rather than merely slow. */
export const NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR = "native hook relay transport failed";

/**
 * Stderr prefix that attributes a child's fail-closed deny to the transport.
 *
 * The response's `failureDisposition` is in-process only, so a deny the child
 * manufactured for itself has no other way to say "OpenClaw could not be
 * reached" rather than "OpenClaw denied this".
 */
export const NATIVE_HOOK_RELAY_DISPOSITION_MARKER = "native hook relay failure disposition:";

/** Detect the terminal transport error so callers escalate instead of fail-closed denying. */
export function isNativeHookRelayTransportFailedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR ||
      error.message.endsWith(`: ${NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR}`))
  );
}
