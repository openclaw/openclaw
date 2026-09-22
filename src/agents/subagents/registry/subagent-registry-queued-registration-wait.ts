import { getGatewayRestartDrainSignal } from "../../../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../../state/openclaw-state-db-cache.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";

/** Borrow cancellation's committed-state wake and the enclosing lifecycle's abort signals. */
export async function waitForQueuedSubagentClaim(params: {
  assertCurrent: () => void;
  pending: () => boolean;
}): Promise<void> {
  const stops: Array<() => void> = [];
  const signals = [getAsyncWorkSignal(), getGatewayRestartDrainSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const check = () => {
        if (settled) {
          return;
        }
        try {
          for (const signal of signals) {
            signal.throwIfAborted();
          }
          params.assertCurrent();
          if (!params.pending()) {
            settled = true;
            resolve();
          }
        } catch (error) {
          settled = true;
          reject(
            error instanceof Error
              ? error
              : new Error("Queued registration claim wait failed", { cause: error }),
          );
        }
      };
      stops.push(onSubagentRegistryPersisted(check));
      // Database subscriptions may synchronously report existing handles. Cleanup
      // runs after subscription setup so that immediate settlement cannot leak one.
      stops.push(registerOpenClawStateDatabaseLifecycleListener(check));
      for (const signal of signals) {
        signal.addEventListener("abort", check, { once: true });
        stops.push(() => signal.removeEventListener("abort", check));
      }
      check();
    });
  } finally {
    for (const stop of stops) {
      stop();
    }
  }
}
