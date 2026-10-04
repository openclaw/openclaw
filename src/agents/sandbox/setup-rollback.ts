/**
 * Attempt-owned rollback for sandbox runtime generations allocated during setup.
 *
 * The native attempt opens one scope around its setup. Only a runtime's lifecycle
 * owner records an allocation, under its own lock and after publishing that exact
 * generation; any later lifecycle operation for the runtime revokes the record.
 * Dispatch hands every allocation off, so rollback reaches only generations a
 * failed setup created and nothing else has claimed since.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/** One recorded allocation; both callbacks belong to the runtime's lifecycle owner. */
type SandboxSetupAllocation = {
  /** Remove the exact generation unless a later lifecycle operation claimed it. */
  retire: () => Promise<void>;
  /** Forget the record without touching the runtime. */
  release: () => void;
};

/** Lifecycle owners record allocations only while the scope is collecting. */
export type SandboxSetupScope = {
  state: "collecting" | "handed-off" | "rolled-back";
  readonly allocations: SandboxSetupAllocation[];
};

export type SandboxSetupRollback = {
  /** Run attempt setup so allocations it makes stay rollback-owned until hand-off. */
  run<T>(setup: () => Promise<T>): Promise<T>;
  /** Dispatch may depend on the runtimes from here on; keep every allocation. */
  handOff(): void;
  /** Retire allocations setup still owns; rejects only after trying each one. */
  rollback(): Promise<void>;
};

// Lazy runtime chunks share one carrier; each allocation keeps its own lifecycle owner.
const currentSandboxSetup = resolveGlobalSingleton(
  Symbol.for("openclaw.sandboxSetupRollback"),
  () => new AsyncLocalStorage<SandboxSetupScope>(),
);

/** Captured before queueing allocation work, so a queued turn keeps its caller's scope. */
export function captureSandboxSetupScope(): SandboxSetupScope | undefined {
  return currentSandboxSetup.getStore();
}

export function createSandboxSetupRollback(): SandboxSetupRollback {
  const scope: SandboxSetupScope = { state: "collecting", allocations: [] };
  const close = (state: "handed-off" | "rolled-back") => {
    if (scope.state !== "collecting") {
      return [];
    }
    scope.state = state;
    return scope.allocations.splice(0);
  };
  return {
    run: (setup) => currentSandboxSetup.run(scope, setup),
    handOff() {
      for (const allocation of close("handed-off")) {
        allocation.release();
      }
    },
    async rollback() {
      const failures: unknown[] = [];
      for (const allocation of close("rolled-back").toReversed()) {
        try {
          await allocation.retire();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Sandbox setup rollback failed.");
      }
    },
  };
}
