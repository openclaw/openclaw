import { randomUUID } from "node:crypto";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";

/** Run delivery under the service owner, never a snapshot of the startup caller. */
export function scheduleServiceDelivery<T>(
  scheduler: PluginServiceSchedulerV1,
  run: () => T,
): Promise<Awaited<T>> {
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(scheduler.signal.reason ?? new Error("Voice Call service stopped"));
    if (scheduler.signal.aborted) {
      onAbort();
      return;
    }
    scheduler.signal.addEventListener("abort", onAbort, { once: true });
    try {
      scheduler.schedule({
        id: `voicecall-delivery:${randomUUID()}`,
        delayMs: 0,
        run: async () => {
          try {
            resolve(await run());
          } catch (error) {
            reject(error);
          } finally {
            scheduler.signal.removeEventListener("abort", onAbort);
          }
        },
      });
    } catch (error) {
      scheduler.signal.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}
