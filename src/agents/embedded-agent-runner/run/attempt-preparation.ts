import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

let nextPreparationStart = Promise.resolve();
const MAX_PREPARATION_STARTS_PER_SLICE = 16;
const PREPARATION_SLICE_MS = 8;
let preparationStarts = MAX_PREPARATION_STARTS_PER_SLICE;
let preparationSyncMs = 0;

/** Dispatches attempt stages without letting concurrent starts monopolize the event loop. */
export function createEmbeddedAttemptPreparation(options: {
  config?: OpenClawConfig;
  assertCurrent: () => void;
}) {
  return async <T>(stage: string, run: () => Promise<T> | T): Promise<T> => {
    // Only start turns are serialized. Async work overlaps, and a failed or cancelled
    // attempt cannot reject the shared tail or inherit another caller's async context.
    const start = nextPreparationStart.then(async () => {
      if (
        preparationStarts >= MAX_PREPARATION_STARTS_PER_SLICE ||
        preparationSyncMs >= PREPARATION_SLICE_MS
      ) {
        await yieldToEventLoop();
        preparationStarts = 0;
        preparationSyncMs = 0;
      }
      preparationStarts++;
    });
    nextPreparationStart = start;
    await start;
    // Check before acquisition; the caller must receive each result before another
    // checkpoint can throw so its existing finally blocks own every acquired resource.
    const startedAt = performance.now();
    try {
      options.assertCurrent();
      return measureEmbeddedAgentPreparation(stage, run, { config: options.config });
    } finally {
      // Charge dispatch work, not asynchronous I/O wait. Cheap stages can share a
      // bounded slice instead of each waiting another congested event-loop turn.
      preparationSyncMs += performance.now() - startedAt;
    }
  };
}
