import { setImmediate as yieldImmediate } from "node:timers/promises";

export type AttemptPrepYieldController = {
  maybeYield: () => Promise<void>;
  reset: () => void;
};

export type AttemptPrepYieldOptions = {
  checkpointBudget?: number;
  yieldNow?: () => Promise<void>;
};

const DEFAULT_CHECKPOINT_BUDGET = 0;

function normalizeCheckpointBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CHECKPOINT_BUDGET;
  }
  return Math.max(0, Math.floor(value));
}

async function defaultYieldNow(): Promise<void> {
  await yieldImmediate();
}

export function createAttemptPrepYieldController(
  options: AttemptPrepYieldOptions = {},
): AttemptPrepYieldController {
  const checkpointBudget = normalizeCheckpointBudget(options.checkpointBudget);
  const yieldNow = options.yieldNow ?? defaultYieldNow;
  let checkpointsSinceYield = 0;

  return {
    async maybeYield() {
      checkpointsSinceYield += 1;
      if (checkpointsSinceYield <= checkpointBudget) {
        return;
      }
      checkpointsSinceYield = 0;
      await yieldNow();
    },
    reset() {
      checkpointsSinceYield = 0;
    },
  };
}
