import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";

type RuntimeUse = {
  users: number;
  generation: number;
  maintenance?: Promise<void>;
};

// The process owns both local turn admission and maintenance. Backend identity
// deliberately fences all of its local installations, including command aliases.
const runtimes = new Map<string, RuntimeUse>();

function runtime(backendId: string): RuntimeUse {
  let state = runtimes.get(backendId);
  if (!state) {
    state = { users: 0, generation: 0 };
    runtimes.set(backendId, state);
  }
  return state;
}

export function readCliRuntimeGeneration(backendId: string): number {
  return runtime(backendId).generation;
}

export async function acquireCliRuntimeUse(
  backendId: string,
  signal: AbortSignal | undefined,
  assertCurrent: () => void,
): Promise<() => void> {
  const state = runtime(backendId);
  while (state.maintenance) {
    await racePromiseWithAbortSignal(state.maintenance, signal);
    assertCurrent();
  }
  signal?.throwIfAborted();
  assertCurrent();
  state.users += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.users -= 1;
  };
}

/** Mutate only while idle. Waiting for active turns can deadlock nested completions. */
export async function withCliBackendMaintenance<T>(
  backendId: string,
  signal: AbortSignal,
  assertCurrent: () => void,
  update: () => Promise<T>,
): Promise<T | undefined> {
  const state = runtime(backendId);
  while (state.maintenance) {
    await racePromiseWithAbortSignal(state.maintenance, signal);
    assertCurrent();
  }
  signal.throwIfAborted();
  assertCurrent();
  if (state.users > 0) {
    return undefined;
  }
  const completed = createDeferred();
  state.maintenance = completed.promise;
  try {
    return await update();
  } finally {
    // Even a failed installer can have replaced part of its installation.
    state.generation += 1;
    state.maintenance = undefined;
    completed.resolve();
  }
}
