import { expectDefined } from "@openclaw/normalization-core/expect";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";

export function createDeferredExecDispatchMock(label = "notification") {
  return {
    dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
      typeof dispatchInboundMessageWithRoutedChannelDispatcher
    >(async ({ replyOptions }) => {
      const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, `${label} lifecycle`);
      const signal = expectDefined(lifecycle.abortSignal, `${label} cancellation`);
      lifecycle.onDeferred?.();
      const onAbort = async () => {
        try {
          await lifecycle.onAbandoned?.();
        } finally {
          await lifecycle.onSettled?.();
        }
      };
      signal.addEventListener("abort", () => void onAbort(), { once: true });
      if (signal.aborted) {
        await onAbort();
      }
      return {
        deferredToActiveRun: "followup",
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }),
  };
}

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

export async function withHeldSupervisorExit<T>(
  run: (exit: Pick<HeldSupervisorExit, "waitStarted">) => Promise<T>,
  settle: () => Promise<void>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run(holdNextSupervisorExit());
  } finally {
    heldSupervisorExit?.release();
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
