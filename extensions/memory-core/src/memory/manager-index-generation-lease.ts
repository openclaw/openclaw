// Memory Core coordinates published-index readers with atomic shadow publication.
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  acquireMemorySqliteWriterLease,
  tryAcquireMemorySqliteLease,
  type MemorySqliteLeaseHandle,
} from "./manager-sqlite-lease.js";
type Waiter = {
  kind: "read" | "write";
  resolve: (release: () => void) => void;
};
type GenerationLeaseKind = Waiter["kind"] | "mutation" | "retrieval";

type GenerationLeaseState = {
  readers: number;
  writer: boolean;
  queue: Waiter[];
};

const states = new Map<string, GenerationLeaseState>();
const CROSS_PROCESS_RETRY_DELAY_MS = 25;

function createGenerationLeaseAbortError(signal?: AbortSignal): Error {
  return new Error("Memory index generation lease acquisition aborted", { cause: signal?.reason });
}

function throwIfGenerationLeaseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createGenerationLeaseAbortError(signal);
  }
}

async function acquireCrossProcessLease(
  databasePath: string,
  kind: GenerationLeaseKind,
  signal?: AbortSignal,
): Promise<MemorySqliteLeaseHandle> {
  const acquireSqliteLease = async (
    location: string,
    mode: "shared" | "exclusive",
  ): Promise<MemorySqliteLeaseHandle> => {
    while (true) {
      throwIfGenerationLeaseAborted(signal);
      const lease = await tryAcquireMemorySqliteLease(location, mode);
      if (lease) {
        if (signal?.aborted) {
          await lease.release();
          throw createGenerationLeaseAbortError(signal);
        }
        return lease;
      }
      try {
        await sleepWithAbort(CROSS_PROCESS_RETRY_DELAY_MS, signal);
      } catch (err) {
        throw signal?.aborted ? createGenerationLeaseAbortError(signal) : err;
      }
    }
  };

  // Admission prevents new readers from overtaking a waiting publisher across
  // processes. Readers release it as soon as their generation lease is secured.
  const admissionLocation = `${databasePath}.generation-writer.sqlite`;
  let admission: MemorySqliteLeaseHandle;
  try {
    admission =
      kind === "write"
        ? await acquireMemorySqliteWriterLease(admissionLocation, signal)
        : await acquireSqliteLease(
            admissionLocation,
            kind === "retrieval" ? "exclusive" : "shared",
          );
  } catch (err) {
    throw signal?.aborted ? createGenerationLeaseAbortError(signal) : err;
  }
  let generation: MemorySqliteLeaseHandle;
  try {
    generation = await acquireSqliteLease(
      `${databasePath}.generation-lock.sqlite`,
      kind === "write" ? "exclusive" : "shared",
    );
  } catch (err) {
    await admission.release();
    throw err;
  }
  if (kind === "read") {
    try {
      await admission.release();
    } catch (err) {
      await generation.release();
      throw err;
    }
    if (signal?.aborted) {
      await generation.release();
      throw createGenerationLeaseAbortError(signal);
    }
    return generation;
  }
  return {
    release: async () => {
      try {
        await generation.release();
      } finally {
        await admission.release();
      }
    },
  };
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
  const releaseLocal = await acquireLocal(key, kind === "write" ? "write" : "read", signal);
  let crossProcess: MemorySqliteLeaseHandle;
  try {
    throwIfGenerationLeaseAborted(signal);
    crossProcess = await acquireCrossProcessLease(key, kind, signal);
    if (signal?.aborted) {
      await crossProcess.release();
      throw createGenerationLeaseAbortError(signal);
    }
  } catch (err) {
    releaseLocal();
    throw err;
  }
  return async () => {
    try {
      await crossProcess.release();
    } finally {
      releaseLocal();
    }
  };
}

export async function acquireMemoryIndexReadGeneration(
  databasePath: string,
  signal?: AbortSignal,
  excludeMutations = false,
): Promise<() => Promise<void>> {
  // Fused reads retain admission exclusively through acceptance, while existing
  // ordinary readers keep their shared generation and can finish independently.
  return await acquire(databasePath, excludeMutations ? "retrieval" : "read", signal);
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
