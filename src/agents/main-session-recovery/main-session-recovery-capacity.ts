import { sleepWithAbort } from "../../infra/backoff.js";

export type MainSessionRecoveryCapacity = {
  acquire: (shouldContinue: () => boolean) => Promise<(() => void) | undefined>;
};

export function createMainSessionRecoveryCapacity(options: {
  limit: number;
  acquireTimeoutMs?: number;
}): MainSessionRecoveryCapacity {
  let active = 0;
  return {
    async acquire(shouldContinue) {
      const deadline = Date.now() + (options.acquireTimeoutMs ?? 60_000);
      while (active >= options.limit && shouldContinue() && Date.now() < deadline) {
        await sleepWithAbort(50, undefined, { ref: false });
      }
      if (!shouldContinue() || active >= options.limit) {
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
