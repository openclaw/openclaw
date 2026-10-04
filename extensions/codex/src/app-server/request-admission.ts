import { coerceErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import type { CodexRequestAttempt } from "./request-attempt.js";
import { CodexAppServerScopedRequestRejectedError } from "./rpc-error.js";

/** Consume authority once at the physical writer; waiter expiry never permits a late write. */
export function dispatchCodexRequestAttempt(
  attempt: CodexRequestAttempt,
  options: { assertCurrent?: () => void; withCurrent?: (write: () => void) => Promise<void> },
  assertTransportCurrent: () => void,
  writeMessage: () => void,
): void {
  if (!attempt.pending) {
    return;
  }
  let consumed = false;
  const write = () => {
    if (consumed) {
      throw new Error("Codex request wire admission was already consumed");
    }
    consumed = true;
    if (!attempt.pending) {
      return;
    }
    assertTransportCurrent();
    try {
      options.assertCurrent?.();
    } catch (cause) {
      throw cause instanceof CodexAppServerScopedRequestRejectedError
        ? cause
        : new CodexAppServerScopedRequestRejectedError(coerceErrorMessage(cause), { cause });
    }
    if (attempt.pending) {
      writeMessage();
    }
  };
  const rejectAdmission = (cause: unknown) => {
    // Only a failure before entering the wire callback proves an authority
    // rejection. The attempt owns possible-write classification after entry.
    attempt.failLocal(
      !consumed && !(cause instanceof CodexAppServerScopedRequestRejectedError)
        ? new CodexAppServerScopedRequestRejectedError(coerceErrorMessage(cause), { cause })
        : toStringifiedError(cause),
    );
  };
  try {
    if (options.withCurrent) {
      // The waiter owns cancellation while preparation is pending. A late grant
      // cannot write a cancelled attempt, and custody never waits for its response.
      void options
        .withCurrent(write)
        .then(() => {
          if (!consumed && attempt.pending) {
            throw new Error("Codex request authority did not admit the wire write");
          }
        })
        .catch(rejectAdmission);
    } else {
      write();
    }
  } catch (error) {
    rejectAdmission(error);
  }
}
