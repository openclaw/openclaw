import fs from "node:fs/promises";

/** Observe a contender's on-disk waiter before making negative custody assertions. */
export async function observeCryptoStoreWaiter(snapshotPath: string) {
  const directory = `${snapshotPath}.owner.waiters`;
  await fs.mkdir(directory, { recursive: true });
  const abort = new AbortController();
  const observed = (async () => {
    for await (const event of fs.watch(directory, { signal: abort.signal })) {
      if (
        (event.eventType === "rename" || event.eventType === "change") &&
        (await fs.readdir(directory)).length > 0
      ) {
        return;
      }
    }
    throw new Error("Waiter watcher ended before the contender registered");
  })();
  return {
    async waitFor(pending: Promise<unknown>) {
      try {
        await Promise.race([
          observed,
          pending.then(
            () => {
              throw new Error("Contender completed before registering a waiter");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]);
      } finally {
        abort.abort();
      }
    },
    close() {
      abort.abort();
    },
  };
}
