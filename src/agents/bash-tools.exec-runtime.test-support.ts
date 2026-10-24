import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";

export function captureProcessUnhandledRejections() {
  const reasons: unknown[] = [];
  const originalProcessEmit = process.emit.bind(process);
  const processEmit = vi.spyOn(process, "emit").mockImplementation((event, ...args) => {
    if (event === "unhandledRejection") {
      reasons.push(args[0]);
      return true;
    }
    return originalProcessEmit(event, ...args);
  });
  return { reasons, restore: () => processEmit.mockRestore() };
}

export type HeldSupervisorExit = {
  wait: Promise<void>;
  waitStarted: Promise<void>;
  markStarted: () => void;
  release: () => void;
};

let heldSupervisorExit: (HeldSupervisorExit & { claimed: boolean }) | undefined;

function holdNextSupervisorExit(): Pick<HeldSupervisorExit, "waitStarted" | "release"> {
  if (heldSupervisorExit) {
    throw new Error("a supervisor exit is already held");
  }
  const exit = createDeferred();
  const started = createDeferred();
  const gate = {
    claimed: false,
    wait: exit.promise,
    waitStarted: started.promise,
    markStarted: started.resolve,
    release: () => {
      if (heldSupervisorExit === gate) {
        heldSupervisorExit = undefined;
      }
      exit.resolve();
    },
  };
  heldSupervisorExit = gate;
  return gate;
}

export function takeHeldSupervisorExit(): HeldSupervisorExit | undefined {
  if (!heldSupervisorExit || heldSupervisorExit.claimed) {
    return undefined;
  }
  heldSupervisorExit.claimed = true;
  return heldSupervisorExit;
}

function releaseHeldSupervisorExit(): void {
  heldSupervisorExit?.release();
}

export async function withHeldSupervisorExit<T>(
  run: (exit: Pick<HeldSupervisorExit, "waitStarted">) => Promise<T>,
  settle: () => Promise<void>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run(holdNextSupervisorExit());
  } finally {
    releaseHeldSupervisorExit();
    try {
      await settle();
    } finally {
      vi.useRealTimers();
    }
  }
}

export function createRunExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

export function runtimeManagedRun(input: SpawnInput, stdout = ""): ManagedRun {
  if (stdout) {
    input.onStdout?.(stdout);
  }
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
    cancel: vi.fn(),
    wait: vi.fn(async () => createRunExit()),
  };
}
