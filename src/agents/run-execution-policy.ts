import {
  assertAdmittedRunForegroundRequest,
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "./admitted-run-context.js";

const requiredForeground = new WeakSet<AdmittedRunContext>();

/** Session creation can tighten a turn; a fresh maintainer request cannot loosen that environment. */
export function requireAdmittedRunForeground(context: AdmittedRunContext | undefined): void {
  const assertCurrent = context && resolveAdmittedRunActiveAssertion(context);
  if (!context || !assertCurrent) {
    throw new Error("Foreground execution requires a fresh authenticated foreground request.");
  }
  assertCurrent();
  assertAdmittedRunForegroundRequest(context);
  requiredForeground.add(context);
}

/** Original input authority survives retries, fallback and later personal model selection. */
export function isAdmittedRunForegroundOnly(context: AdmittedRunContext | undefined): boolean {
  return Boolean(
    context &&
    (requiredForeground.has(context) ||
      readAdmittedRunOperatorAuthority(context)?.rolePolicy?.execution === "foreground-only"),
  );
}

/** Consumers pass only host-captured admission or immutable session facts. */
export function assertExecutionMayContinue(foregroundOnly: boolean, activity: string): void {
  if (foregroundOnly) {
    throw new Error(
      `${activity} cannot outlive this foreground request. Keep the work in this thread and send a new message when needed.`,
    );
  }
}
