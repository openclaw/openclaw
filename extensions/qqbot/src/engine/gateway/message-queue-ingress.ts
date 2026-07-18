// QQBot plugin module fans one merged turn lifecycle across its durable claims.
import type { QueuedMessage } from "./message-queue.js";
import type { QQBotIngressLifecycle } from "./types.js";

export function buildQQBotMergedIngressLifecycle(
  messages: readonly QueuedMessage[],
): QQBotIngressLifecycle | undefined {
  const lifecycles = messages
    .map((message) => message.turnAdoptionLifecycle)
    .filter((lifecycle) => lifecycle !== undefined);
  const [firstLifecycle] = lifecycles;
  if (!firstLifecycle) {
    return undefined;
  }
  if (lifecycles.length === 1) {
    return firstLifecycle;
  }
  return {
    abortSignal: AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
    onAdopted: async () => {
      for (const lifecycle of lifecycles) {
        await lifecycle.onAdopted();
      }
    },
    onDeferred: () => {
      for (const lifecycle of lifecycles) {
        lifecycle.onDeferred();
      }
    },
    onAdoptionFinalizing: () => {
      for (const lifecycle of lifecycles) {
        lifecycle.onAdoptionFinalizing();
      }
    },
    onAbandoned: async () => {
      for (const lifecycle of lifecycles) {
        await lifecycle.onAbandoned();
      }
    },
  };
}
