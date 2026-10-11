import { formatErrorMessage } from "../../../infra/errors.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { log } from "../logger.js";

export type EmbeddedAttemptSteeringAdmission = {
  accepting: boolean;
  readonly closed: boolean;
  stop: () => void;
  bindStreamUnsubscribe: (unsubscribe: () => void) => () => void;
};

/** Owns steering through preparation rollback, prompt closure, and stream release. */
export function withEmbeddedAttemptSteeringAdmission<T>(
  session: AgentSession,
  signal: AbortSignal,
  prepare: (admission: EmbeddedAttemptSteeringAdmission) => T,
): T {
  let phase: "accepting" | "paused" | "closed" = "accepting";
  let unsubscribeSteering: (() => void) | undefined;
  let unsubscribeStream: (() => void) | undefined;
  const stop = () => {
    if (phase === "closed") {
      return;
    }
    phase = "closed";
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
      get closed() {
        return phase === "closed";
      },
      get accepting() {
        return phase === "accepting";
      },
      set accepting(value) {
        if (phase !== "closed") {
          phase = value ? "accepting" : "paused";
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
