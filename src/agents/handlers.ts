import { registerCommandHandler } from "../process/command-queue.js";
import {
  compactEmbeddedPiSessionDirect,
  type CompactEmbeddedPiSessionParams,
} from "./pi-embedded-runner/compact.js";

/**
 * Register task handlers for crash recovery.
 *
 * Live calls use `executeFn` closures (preserving all streaming callbacks).
 * These handlers are only invoked when recovering persisted tasks after a
 * process restart — the deserialized payload will lack function-valued
 * properties, so output is best-effort.
 */
export function initializeAgentHandlers() {
  registerCommandHandler("SESSION_LOCK", async () => {
    // No-op: session locks are pure concurrency gates.
  });

  registerCommandHandler("EMBEDDED_PI_RUN", async (_payload: unknown) => {
    console.warn(
      "[queue-recovery] EMBEDDED_PI_RUN task recovered but cannot be re-executed " +
        "(streaming callbacks lost during serialization). Skipping.",
    );
    return undefined;
  });

  registerCommandHandler("EMBEDDED_PI_COMPACT", async (payload: unknown) => {
    return compactEmbeddedPiSessionDirect(payload as CompactEmbeddedPiSessionParams);
  });
}
