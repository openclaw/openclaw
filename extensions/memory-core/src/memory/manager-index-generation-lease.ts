// Memory Core coordinates published-index readers with atomic shadow publication.
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
type Waiter = {
  kind: "read" | "write";
  resolve: (release: () => void) => void;
};
type GenerationLeaseKind = Waiter["kind"] | "mutation";

type GenerationLeaseState = {
  readers: number;
  writer: boolean;
  queue: Waiter[];
};

const states = new Map<string, GenerationLeaseState>();

function createGenerationLeaseAbortError(signal?: AbortSignal): Error {
  return new Error("Memory index generation lease acquisition aborted", { cause: signal?.reason });
}

function throwIfGenerationLeaseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createGenerationLeaseAbortError(signal);
  }
}

function stateFor(key: string): GenerationLeaseState {
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const created = { readers: 0, writer: false, queue: [] };
  states.set(key, created);
  return created;
}

function drain(key: string, state: GenerationLeaseState): void {
  if (state.writer) {
    return;
  }
  const first = state.queue[0];
  if (!first) {
    if (state.readers === 0) {
      states.delete(key);
    }
    return;
  }
  if (first.kind === "write") {
    if (state.readers > 0) {
      return;
    }
    state.queue.shift();
    state.writer = true;
    first.resolve(() => {
      state.writer = false;
      drain(key, state);
    });
    return;
  }
  // Admit the full consecutive group before resolving any caller: an aborted
  // caller can release synchronously and must not let a writer overtake siblings.
  const readers: Waiter[] = [];
  while (state.queue[0]?.kind === "read") {
    readers.push(state.queue.shift()!);
  }
  state.readers += readers.length;
  for (const reader of readers) {
    reader.resolve(() => {
      state.readers -= 1;
      drain(key, state);
    });
  }
}

async function acquireLocal(
  key: string,
  kind: Waiter["kind"],
  signal?: AbortSignal,
): Promise<() => void> {
  throwIfGenerationLeaseAborted(signal);
  const state = stateFor(key);
  return await new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      kind,
      resolve: (release) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          release();
          reject(createGenerationLeaseAbortError(signal));
          return;
        }
        resolve(release);
      },
    };
    const onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index < 0) {
        return;
      }
      state.queue.splice(index, 1);
      signal?.removeEventListener("abort", onAbort);
      drain(key, state);
      reject(createGenerationLeaseAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    state.queue.push(waiter);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    drain(key, state);
  });
}

async function acquire(
  databasePath: string,
  kind: GenerationLeaseKind,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const key = resolveUserPath(databasePath);
  const release = await acquireLocal(key, kind === "write" ? "write" : "read", signal);
  return async () => release();
}

export async function acquireMemoryIndexReadGeneration(
  databasePath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  // One Gateway owns this database; simultaneous foreign processes are unsupported.
  return await acquire(databasePath, "read", signal);
}

export async function withMemoryIndexGeneration<T>(
  databasePath: string,
  kind: "mutation" | "write",
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquire(databasePath, kind);
  try {
    return await run();
  } finally {
    await release();
  }
}
