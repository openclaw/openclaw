import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { GatewayRetainedWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawStatePathAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { withSandboxRegistryPublication } from "./registry-publication.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

const lifetimes = new Map<string, ReturnType<typeof createLifetime>>();
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;

type RuntimeUseTarget =
  | { scopeKey: string; workspaceDir?: string }
  | { scopeKey?: string; workspaceDir: string };
type RuntimeSlot = { reservations: number; active: number; pruning?: Promise<void> };

function createLifetime({ admission }: OpenClawStateWorkerContext) {
  const key = admission.identity.canonicalPath;
  const work = new GatewayRetainedWorkScope();
  const slots = new Map<string, RuntimeSlot>();
  let housekeeping: Promise<void> | undefined;
  let lastHousekeepingAtMs = -Infinity;
  let recurringHousekeeping:
    | { run: () => Promise<void>; onError: (error: unknown) => void }
    | undefined;
  let housekeepingTimer: ReturnType<typeof setInterval> | undefined;
  const stopHousekeepingTimer = () => {
    clearInterval(housekeepingTimer);
    housekeepingTimer = undefined;
  };
  const tickHousekeeping = () => {
    const recurring = recurringHousekeeping;
    if (!recurring || work.isClosing || housekeeping) {
      return;
    }
    void owner.maybeRunHousekeeping(recurring.run).catch(recurring.onError);
  };
  const armHousekeepingTimer = () => {
    if (recurringHousekeeping && !housekeepingTimer && !work.isClosing) {
      housekeepingTimer = runInDetachedAsyncContext(() =>
        setInterval(tickHousekeeping, HOUSEKEEPING_INTERVAL_MS),
      );
      housekeepingTimer.unref();
    }
  };
  const selectSlots = (target: RuntimeUseTarget) => {
    const keys = target.scopeKey === undefined ? [] : [`scope:${target.scopeKey}`];
    if (target.workspaceDir !== undefined) {
      keys.push(`workspace:${target.workspaceDir}`);
    }
    return keys.map((slotKey) => {
      let slot = slots.get(slotKey);
      if (!slot) {
        slot = { reservations: 0, active: 0 };
        slots.set(slotKey, slot);
      }
      return { slotKey, slot };
    });
  };
  const forgetUnused = (selected: ReturnType<typeof selectSlots>) => {
    for (const { slotKey, slot } of selected) {
      if (!slot.reservations && !slot.pruning) {
        slots.delete(slotKey);
      }
    }
  };
  const owner = {
    retainGateway() {
      const gateway = work.retainGateway();
      const beginClose = () => {
        gateway.beginClose();
        if (work.isClosing) {
          stopHousekeepingTimer();
          recurringHousekeeping = undefined;
        }
      };
      return {
        beginClose,
        drain: () => {
          beginClose();
          return gateway.drain();
        },
      };
    },
    run<T>(run: () => Promise<T>): Promise<T> {
      if (work.isClosing) {
        return Promise.reject(new Error("Sandbox registry admission is closed"));
      }
      // Accepted removal owns its persistence signal across scheduler cancellation.
      return work.scope.track(run);
    },
    async acquire(target: RuntimeUseTarget): Promise<Disposable> {
      if (work.isClosing) {
        throw new Error("Sandbox registry admission is closed");
      }
      const selected = selectSlots(target);
      // Reserve before waiting so a later prune cannot overtake an admitted start.
      for (const { slot } of selected) {
        slot.reservations++;
      }
      let active = false;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        for (const { slot } of selected) {
          slot.reservations--;
          if (active) {
            slot.active--;
          }
        }
        forgetUnused(selected);
      };
      try {
        const pending = selected.flatMap(({ slot }) => (slot.pruning ? [slot.pruning] : []));
        if (pending.length) {
          await Promise.all(pending);
        }
        if (work.isClosing) {
          throw new Error("Sandbox registry admission is closed");
        }
        for (const { slot } of selected) {
          slot.active++;
        }
        active = true;
        return { [Symbol.dispose]: release };
      } catch (error) {
        release();
        throw error;
      }
    },
    prune(
      target: RuntimeUseTarget,
      run: (assertCurrent: () => void) => Promise<void>,
    ): Promise<void> {
      const selected = selectSlots(target);
      if (selected.some(({ slot }) => slot.reservations > 0 || slot.pruning !== undefined)) {
        forgetUnused(selected);
        return Promise.resolve();
      }
      const pending = createDeferredCore();
      for (const { slot } of selected) {
        slot.pruning = pending.promise;
      }
      const assertCurrent = () => {
        if (selected.some(({ slot }) => slot.active || slot.pruning !== pending.promise)) {
          throw new Error("Sandbox runtime is held by an admitted turn");
        }
      };
      return owner
        .run(() => run(assertCurrent))
        .finally(() => {
          for (const { slot } of selected) {
            slot.pruning = undefined;
          }
          forgetUnused(selected);
          pending.resolve();
        });
    },
    maybeRunHousekeeping(run: () => Promise<void>): Promise<void> {
      if (housekeeping) {
        return housekeeping;
      }
      const now = Date.now();
      if (now - lastHousekeepingAtMs < HOUSEKEEPING_INTERVAL_MS) {
        return Promise.resolve();
      }
      lastHousekeepingAtMs = now;
      housekeeping = runInDetachedAsyncContext(() => owner.run(run)).finally(() => {
        housekeeping = undefined;
      });
      return housekeeping;
    },
    startHousekeeping(run: () => Promise<void>, onError: (error: unknown) => void): void {
      if (work.isClosing) {
        throw new Error("Sandbox registry admission is closed");
      }
      if (recurringHousekeeping) {
        return;
      }
      recurringHousekeeping = { run, onError };
      armHousekeepingTimer();
      tickHousekeeping();
    },
  };
  const unregister = registerOpenClawStatePathAsyncResource(admission, async () => {
    stopHousekeepingTimer();
    await work.beginDrainAll();
    if (work.hasGateways) {
      // Read admission may retire while the Gateway still owns the close prelude.
      work.reopen();
      armHousekeepingTimer();
    } else {
      recurringHousekeeping = undefined;
      lifetimes.delete(key);
      unregister();
    }
  });
  return owner;
}

function lifetime(context: OpenClawStateWorkerContext) {
  const key = context.admission.identity.canonicalPath;
  let owner = lifetimes.get(key);
  if (!owner) {
    owner = createLifetime(context);
    lifetimes.set(key, owner);
  }
  return owner;
}

export function withSandboxRegistrySettlement<T>(
  context: OpenClawStateWorkerContext,
  run: () => Promise<T>,
): Promise<T> {
  context.admission.assertCurrent();
  return lifetime(context).run(run);
}

export function prepareSandboxRegistryClose() {
  return lifetime(captureOpenClawStateWorkerContext()).retainGateway();
}

/** A context holds its runtime scope; managed preparation also holds its exact projection. */
export async function acquireSandboxRuntimeUse(
  target: RuntimeUseTarget,
  context = captureOpenClawStateWorkerContext(),
): Promise<Disposable> {
  context.admission.assertCurrent();
  const use = await lifetime(context).acquire(target);
  try {
    context.admission.assertCurrent();
    return use;
  } catch (error) {
    use[Symbol.dispose]();
    throw error;
  }
}

/** Pruning owns admission through removal; same-slot starts wait before using the runtime. */
export function withSandboxRuntimePrune(
  entry: Pick<SandboxRegistryEntry, "sessionKey" | "workspaceDir">,
  run: (assertPruneCurrent: () => void) => Promise<void>,
  context = captureOpenClawStateWorkerContext(),
): Promise<void> {
  context.admission.assertCurrent();
  return lifetime(context).prune(
    { scopeKey: entry.sessionKey, workspaceDir: entry.workspaceDir },
    run,
  );
}

/** Background housekeeping has state-root lifetime, not the initiating turn's async context. */
export function maybeRunSandboxRegistryHousekeeping(
  run: () => Promise<void>,
  context = captureOpenClawStateWorkerContext(),
): Promise<void> {
  context.admission.assertCurrent();
  return lifetime(context).maybeRunHousekeeping(run);
}

/** Revisit idle runtimes even when no later turn arrives to request another pass. */
export function startSandboxRegistryHousekeeping(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  context = captureOpenClawStateWorkerContext(),
): void {
  context.admission.assertCurrent();
  lifetime(context).startHousekeeping(run, onError);
}

/** Provider-confirmed removal keeps only exact terminal cleanup authority after read admission closes. */
export async function finishSandboxRegistryRemoval(
  context: OpenClawStateWorkerContext,
  identity: DatabasePathIdentity,
  entry: SandboxRegistryEntry,
  guard?: WorkspaceStateGuard,
): Promise<void> {
  const { openOpenClawStateWorkerCleanupStore } =
    await import("../../state/openclaw-state-worker-store.js");
  const { createSqliteWorkerWriteAdmission, runSqliteWorkerStoreOperation } =
    await import("../../infra/sqlite-worker-store.js");
  const cleanupContext = {
    environment: context.environment,
    existingSchemaPath: context.existingSchemaPath,
    stateIntegrity: context.stateIntegrity,
  };
  let active = true;
  const assertOwned = () => {
    if (!active) {
      throw new Error("Sandbox registry removal has settled");
    }
    guard?.assertHost?.();
  };
  guard?.beforeLegacyApply?.();
  const store = await openOpenClawStateWorkerCleanupStore(
    context.admission.databasePath,
    cleanupContext,
    assertOwned,
    identity,
    context.maintenanceScope,
  );
  if (!store) {
    throw new Error("Sandbox removal lost its original shared database");
  }
  const errors: unknown[] = [];
  try {
    await runSqliteWorkerStoreOperation(
      store,
      (scope) => scope.execute({ type: "sandboxRegistry.finishRemoval", input: entry }),
      cleanupContext,
      assertOwned,
      withSandboxRegistryPublication(
        createSqliteWorkerWriteAdmission(assertOwned, [context.admission.databasePath]),
        () => identity.key,
        assertOwned,
      ),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await store.close();
  } catch (error) {
    errors.push(error);
  } finally {
    active = false;
  }
  throwSqliteLifecycleErrors(errors, "Sandbox removal settlement and worker cleanup failed");
}
