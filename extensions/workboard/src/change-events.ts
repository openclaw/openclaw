import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

export function createWorkboardChangeEventService(
  store: Pick<WorkboardStore, "ready" | "subscribeChanges" | "announceChangeEpoch">,
): OpenClawPluginService & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;

  return {
    id: "workboard-change-events",
    async start(ctx) {
      const gatewayEvents = ctx.gatewayEvents;
      if (!gatewayEvents || unsubscribe) {
        return;
      }
      await store.ready();
      const emit = (change: WorkboardChange) => {
        gatewayEvents.emit("changed", change, {
          scope: "operator.read",
        });
      };
      unsubscribe = store.subscribeChanges(emit);
      store.announceChangeEpoch();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
