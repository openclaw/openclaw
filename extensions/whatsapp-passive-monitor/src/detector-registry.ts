import type { DetectorExecCtx } from "./interfaces/detector.ts";

type DetectorExecutor = (ctx: DetectorExecCtx) => Promise<unknown>;

export type DetectorRegistry = {
  /** Register an initialized detector executor */
  add: (executor: DetectorExecutor) => void;
  /** Run all registered detectors sequentially */
  runAll: (ctx: DetectorExecCtx) => Promise<void>;
};

export const createDetectorRegistry = (): DetectorRegistry => {
  const detectors: DetectorExecutor[] = [];

  return {
    add: (executor) => {
      detectors.push(executor);
    },
    runAll: async (ctx) => {
      for (const detector of detectors) {
        try {
          await detector(ctx);
        } catch (err) {
          console.error(`detector-registry: detector failed: ${String(err)}`);
        }
      }
    },
  };
};
