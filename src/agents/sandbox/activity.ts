/** Coordinates in-process sandbox use with destructive container lifecycle changes. */
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type SandboxActivityLease = {
  release(): void;
  upgradeToMutation(): Promise<void>;
};

type ActivityWaiter = {
  kind: "activity";
  resolve: (lease: SandboxActivityLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
type MutationWaiter = { kind: "mutation"; resolve: () => void };
type ActivityState = {
  readers: number;
  writer: boolean;
  queue: Array<ActivityWaiter | MutationWaiter>;
};

const STATES = resolveGlobalSingleton(
  Symbol.for("openclaw.sandboxActivityStates"),
  () => new Map<string, ActivityState>(),
);

function getState(runtimeId: string): ActivityState {
  const existing = STATES.get(runtimeId);
  if (existing) {
    return existing;
  }
  const state: ActivityState = { readers: 0, writer: false, queue: [] };
  STATES.set(runtimeId, state);
  return state;
}

function drain(runtimeId: string, state: ActivityState): void {
  if (state.writer || state.readers > 0) {
    return;
  }
  const next = state.queue[0];
  if (next?.kind === "mutation") {
    state.queue.shift();
    state.writer = true;
    next.resolve();
    return;
  }
  while (state.queue[0]?.kind === "activity") {
    const waiter = state.queue.shift() as ActivityWaiter;
    waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
    if (waiter.signal?.aborted) {
      waiter.reject(createAbortError("Aborted"));
    } else {
      state.readers += 1;
      waiter.resolve(createLease(runtimeId, state));
    }
  }
  if (!state.writer && state.readers === 0 && state.queue.length === 0) {
    STATES.delete(runtimeId);
  }
}

function waitForMutation(runtimeId: string, state: ActivityState): Promise<void> {
  // Queue synchronously before yielding so later activity cannot slip ahead.
  return new Promise<void>((resolve) => {
    state.queue.push({ kind: "mutation", resolve });
    drain(runtimeId, state);
  });
}

function createLease(runtimeId: string, state: ActivityState): SandboxActivityLease {
  let mode: "activity" | "pending" | "mutation" | "released" = "activity";
  return {
    release() {
      if (mode === "activity") {
        state.readers -= 1;
      } else if (mode === "mutation") {
        state.writer = false;
      } else {
        return;
      }
      mode = "released";
      drain(runtimeId, state);
    },
    async upgradeToMutation() {
      if (mode !== "activity") {
        throw new Error("Sandbox activity lease can only be upgraded once");
      }
      mode = "pending";
      state.readers -= 1;
      await waitForMutation(runtimeId, state);
      mode = "mutation";
    },
  };
}

export async function acquireSandboxActivity(
  runtimeId: string,
  signal?: AbortSignal,
): Promise<SandboxActivityLease> {
  if (signal?.aborted) {
    throw createAbortError("Aborted");
  }
  const state = getState(runtimeId);
  if (!state.writer && state.queue.length === 0) {
    state.readers += 1;
    return createLease(runtimeId, state);
  }
  return await new Promise<SandboxActivityLease>((resolve, reject) => {
    const waiter: ActivityWaiter = { kind: "activity", resolve, reject, signal };
    waiter.onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) {
        state.queue.splice(index, 1);
        reject(createAbortError("Aborted"));
        drain(runtimeId, state);
      }
    };
    state.queue.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal?.aborted) {
      waiter.onAbort();
    }
  });
}

export function tryAcquireSandboxActivity(runtimeId: string): SandboxActivityLease | null {
  const state = getState(runtimeId);
  if (state.writer || state.queue.length > 0) {
    return null;
  }
  state.readers += 1;
  return createLease(runtimeId, state);
}

export async function withSandboxIdleMutation<T>(
  runtimeId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const state = getState(runtimeId);
  await waitForMutation(runtimeId, state);
  try {
    return await mutate();
  } finally {
    state.writer = false;
    drain(runtimeId, state);
  }
}
