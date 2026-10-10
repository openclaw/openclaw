import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

const MAX_FRAME_OPERATIONS = 128;

/** Frame reads and pruning share admission while SQLite remains owned by the worker. */
export function acquireLogbookFrameIo(root: string) {
  const state = resolveGlobalSingleton(Symbol.for("openclaw.logbookFrameIo"), () => ({
    queue: new KeyedAsyncQueue(),
    pending: 0,
  }));
  const accepted = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing) {
        return Promise.reject(new Error("Logbook frame I/O is closed"));
      }
      if (state.pending >= MAX_FRAME_OPERATIONS) {
        return Promise.reject(
          Object.assign(new Error("Logbook frame I/O queue capacity reached"), {
            code: "overloaded",
          }),
        );
      }
      state.pending += 1;
      const result = state.queue.enqueue(root, operation);
      accepted.add(result);
      const settle = () => {
        state.pending -= 1;
        accepted.delete(result);
      };
      void result.then(settle, settle);
      return result;
    },
    close(): Promise<void> {
      closing ??= Promise.allSettled(accepted).then(() => undefined);
      return closing;
    },
  };
}
