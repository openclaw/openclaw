import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

export function createWorkboardChangeEventService(
  store: Pick<WorkboardStore, "ready" | "subscribeChanges" | "announceChangeEpoch">,
): OpenClawPluginService & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;

  return {
    id: "workboard-change-events",
    start(ctx) {
      const gatewayEvents = ctx.gatewayEvents;
      if (!gatewayEvents || unsubscribe) {
        return Promise.resolve();
      }
      if (starting?.generation === generation) {
        return starting.promise;
      }
      const currentGeneration = generation;
      const previous = starting?.promise;
      const pending = (async () => {
        await previous?.catch(() => undefined);
        await store.ready();
        if (currentGeneration !== generation) {
          return;
        }
        const emit = (change: WorkboardChange) => {
          gatewayEvents.emit("changed", change, {
            scope: "operator.read",
          });
        };
        unsubscribe = store.subscribeChanges(emit);
        store.announceChangeEpoch();
      })().finally(() => {
        if (starting?.promise === pending) {
          starting = undefined;
        }
      });
      starting = { generation: currentGeneration, promise: pending };
      return pending;
    },
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      return Promise.allSettled([starting?.promise]).then(() => undefined);
    },
  };
}
