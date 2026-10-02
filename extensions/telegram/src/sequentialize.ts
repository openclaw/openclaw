import { getTelegramSequentialConstraints } from "./sequential-key.js";

export function createTelegramSequentializer() {
  const tails = new Map<string, Promise<void>>();
  return async (
    ctx: Parameters<typeof getTelegramSequentialConstraints>[0],
    next: () => Promise<void>,
  ): Promise<void> => {
    const constraints = getTelegramSequentialConstraints(ctx);
    const keys = Array.isArray(constraints) ? constraints : [constraints];
    const previous = keys.map((key) => tails.get(key)).filter((tail) => tail !== undefined);
    const task = Promise.all(previous).then(next);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    // Reserve all keys before yielding, including keys whose previous work is still waiting.
    for (const key of keys) {
      tails.set(key, tail);
    }
    try {
      await task;
    } finally {
      for (const key of keys) {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    }
  };
}
