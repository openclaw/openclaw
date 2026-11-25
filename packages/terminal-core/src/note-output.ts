// Note output routing stays dependency-free so CLI bootstrap owners can install it without Clack.
import { AsyncLocalStorage } from "node:async_hooks";

const noteOutputStorage = new AsyncLocalStorage<() => NodeJS.WriteStream>();

/** The invocation's output-mode owner chooses where notes render for work in callback. */
export function withNoteOutput<T>(resolveOutput: () => NodeJS.WriteStream, callback: () => T): T {
  return noteOutputStorage.run(resolveOutput, callback);
}

export function resolveNoteOutput(): NodeJS.WriteStream {
  return noteOutputStorage.getStore()?.() ?? process.stdout;
}
