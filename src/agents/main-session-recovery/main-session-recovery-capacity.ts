import { sleepWithAbort } from "../../infra/backoff.js";

export type MainSessionRecoveryCapacity = {
  acquire: (
    shouldContinue: () => boolean,
    onWaiting?: () => Promise<void>,
  ) => Promise<(() => void) | undefined>;
};

export function createMainSessionRecoveryCapacity(options: {
  limit: number;
}): MainSessionRecoveryCapacity {
  let active = 0;
  return {
    async acquire(shouldContinue, onWaiting) {
      if (active >= options.limit && shouldContinue()) {
        await onWaiting?.();
      }
      while (active >= options.limit && shouldContinue()) {
        await sleepWithAbort(50, undefined, { ref: false });
      }
      if (!shouldContinue()) {
        return undefined;
      }
      active += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        active -= 1;
      };
    },
  };
}
