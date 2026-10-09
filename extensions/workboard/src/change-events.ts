import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;

export function createWorkboardChangeEventService(
  store: Pick<
    WorkboardStore,
    "ready" | "subscribeChanges" | "announceChangeEpoch" | "reconcileExternalChanges"
  >,
): OpenClawPluginService & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;
  let polling: Promise<void> | undefined;

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
        timer = setInterval(() => {
          if (polling) {
            return;
          }
          polling = store
            .reconcileExternalChanges()
            .then(
              () => undefined,
              (error: unknown) => {
                ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
              },
            )
            .finally(() => {
              polling = undefined;
            });
        }, WORKBOARD_EXTERNAL_CHANGE_CHECK_MS);
        timer.unref?.();
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
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      return Promise.allSettled([starting?.promise, polling]).then(() => undefined);
    },
  };
}
