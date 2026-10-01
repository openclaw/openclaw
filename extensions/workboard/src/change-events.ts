import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const DEFAULT_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 12_000;
const MIN_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1_000;
const MAX_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 60_000;
const WORKBOARD_EXTERNAL_CHANGE_MAX_BACKOFF_MS = 60_000;

function resolveExternalChangeCheckMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKBOARD_EXTERNAL_CHANGE_CHECK_MS?.trim();
  if (!raw) {
    return DEFAULT_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS;
  }
  return Math.min(
    MAX_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS,
    Math.max(MIN_WORKBOARD_EXTERNAL_CHANGE_CHECK_MS, Math.trunc(parsed)),
  );
}

/** Exported for tests; production uses resolveExternalChangeCheckMs(). */
export const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = resolveExternalChangeCheckMs();

export function createWorkboardChangeEventService(
  store: Pick<
    WorkboardStore,
    "ready" | "subscribeChanges" | "announceChangeEpoch" | "reconcileExternalChanges"
  >,
): OpenClawPluginService & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;
  let polling: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let nextDelayMs = resolveExternalChangeCheckMs();

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
        const baseMs = resolveExternalChangeCheckMs();
        nextDelayMs = baseMs;

        const schedule = () => {
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(tick, nextDelayMs);
          timer.unref?.();
        };

        const tick = () => {
          if (polling) {
            schedule();
            return;
          }
          polling = store
            .reconcileExternalChanges()
            .then(
              () => {
                consecutiveFailures = 0;
                nextDelayMs = baseMs;
              },
              (error: unknown) => {
                ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
                consecutiveFailures += 1;
                // Exponential backoff on failure (circuit soft-open): base, 2x, 4x… capped.
                // Resets to baseMs on the next success. Env-only interval raise
                // without this still helps, but does not stop failure storms.
                nextDelayMs = Math.min(
                  WORKBOARD_EXTERNAL_CHANGE_MAX_BACKOFF_MS,
                  baseMs * 2 ** Math.min(consecutiveFailures, 5),
                );
              },
            )
            .finally(() => {
              polling = undefined;
              if (currentGeneration === generation) {
                schedule();
              }
            });
        };

        schedule();
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
        clearTimeout(timer);
        timer = undefined;
      }
      return Promise.allSettled([starting?.promise, polling]).then(() => undefined);
    },
  };
}
