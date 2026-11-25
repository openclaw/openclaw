// Note output routing stays dependency-free so CLI bootstrap owners can install it without Clack.
import { AsyncLocalStorage } from "node:async_hooks";

const noteOutputStorage = new AsyncLocalStorage<() => NodeJS.WriteStream>();
const suppressNotesStorage = new AsyncLocalStorage<boolean>();

/** The invocation's output-mode owner chooses where notes render for work in callback. */
export function withNoteOutput<T>(resolveOutput: () => NodeJS.WriteStream, callback: () => T): T {
  return noteOutputStorage.run(resolveOutput, callback);
}

export function resolveNoteOutput(): NodeJS.WriteStream {
  return noteOutputStorage.getStore()?.() ?? process.stdout;
}

export function withSuppressedNotes<T>(callback: () => T): T {
  return suppressNotesStorage.run(true, callback);
}

export function areNotesSuppressedInScope(): boolean {
  return suppressNotesStorage.getStore() === true;
}
