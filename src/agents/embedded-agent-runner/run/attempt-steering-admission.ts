import { formatErrorMessage } from "../../../infra/errors.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { log } from "../logger.js";

export type EmbeddedAttemptSteeringAdmission = {
  accepting: boolean;
  stop: () => void;
  bindStreamUnsubscribe: (unsubscribe: () => void) => () => void;
};

/** Owns steering through preparation rollback, prompt closure, and stream release. */
export function withEmbeddedAttemptSteeringAdmission<T>(
  session: AgentSession,
  signal: AbortSignal,
  prepare: (admission: EmbeddedAttemptSteeringAdmission) => T,
): T {
  let accepting = true;
  let closed = false;
  let unsubscribeSteering: (() => void) | undefined;
  let unsubscribeStream: (() => void) | undefined;
  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    accepting = false;
    signal.removeEventListener("abort", stop);
    unsubscribeSteering?.();
  };
  const unsubscribe = () => {
    const releaseStream = unsubscribeStream;
    unsubscribeStream = undefined;
    try {
      stop();
    } finally {
      releaseStream?.();
    }
  };
  try {
    unsubscribeSteering = session.subscribe((event) => {
      if (event.type === "agent_settled" || event.type === "agent_handoff") {
        stop();
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }
    return prepare({
      get accepting() {
        return accepting;
      },
      set accepting(value) {
        if (!closed) {
          accepting = value;
        }
      },
      stop,
      bindStreamUnsubscribe: (releaseStream) => {
        unsubscribeStream = releaseStream;
        return unsubscribe;
      },
    });
  } catch (error) {
    try {
      unsubscribe();
    } catch (cleanupError) {
      log.error(
        `CRITICAL: embedded stream subscription cleanup failed: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}
