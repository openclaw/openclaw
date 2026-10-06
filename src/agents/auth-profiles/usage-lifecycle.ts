import {
  getBoundLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";

type UsageWork = {
  work: AsyncWorkScope;
  closing: boolean;
  settled?: Promise<void>;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.authProfileUsageWork"), () => ({
  owners: new WeakMap<LegacyPluginSdkResourceHost, UsageWork>(),
  preparations: new Map<string, Promise<void>>(),
}));

function usageWork(host: LegacyPluginSdkResourceHost): UsageWork {
  let owner = state.owners.get(host);
  if (!owner) {
    owner = { work: new AsyncWorkScope(), closing: false };
    state.owners.set(host, owner);
  }
  return owner;
}

/** Reserve native-writer order while asynchronous reads choose the physical owner. */
export function reserveAuthProfileUsageWrite<T>(options: OpenClawAgentDatabaseOptions) {
  const assignment = createDeferredCore<(() => Promise<T>) | undefined>();
  const controller = new AbortController();
  let selected = false;
  let released = false;
  const completion = runOpenClawAgentWriteAdmission(
    options,
    async () => {
      const operation = await assignment.promise;
      return operation ? { value: await operation() } : undefined;
    },
    true,
    undefined,
    controller.signal,
  );
  // A candidate can be refused before routing selects it; run/dispose join that result.
  void completion.catch(() => {});
  const release = () => {
    if (selected || released) {
      return;
    }
    released = true;
    assignment.resolve(undefined);
    controller.abort(new Error("Unused auth usage writer reservation"));
  };
  return {
    async run(operation: () => Promise<T>): Promise<T> {
      if (released) {
        return operation();
      }
      selected = true;
      assignment.resolve(operation);
      const result = await completion;
      if (!result) {
        throw new Error("Auth usage writer reservation settled without its operation");
      }
      return result.value;
    },
    release,
    async dispose() {
      release();
      // Selected failures reach run(); unselected candidates never execute a write.
      await Promise.allSettled([completion]);
    },
  };
}

/** Reserve overlapping physical stores before asynchronous reads can reorder ready writes. */
export function reserveAuthProfileUsagePreparation(ownerKeys: readonly string[]) {
  const keys = [...new Set(ownerKeys)];
  const ready = Promise.all(
    keys.flatMap((key) => {
      const pending = state.preparations.get(key);
      return pending ? [pending] : [];
    }),
  ).then(() => {});
  const completion = createDeferredCore();
  for (const key of keys) {
    state.preparations.set(key, completion.promise);
  }
  return {
    ready,
    release() {
      completion.resolve();
      for (const key of keys) {
        if (state.preparations.get(key) === completion.promise) {
          state.preparations.delete(key);
        }
      }
    },
  };
}

/** Own preparation and persistence together before the auth writer can yield. */
export async function runAuthProfileUsage<T>(operation: () => Promise<T>): Promise<T> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const run = () => (maintenance ? maintenance.run(operation) : operation());
  const host = getBoundLegacyPluginSdkResourceHost();
  if (!host) {
    return trackAsyncWork(run);
  }
  const owner = usageWork(host);
  if (owner.closing) {
    throw new Error("Auth profile usage owner is closed");
  }
  host.scheduler.signal.throwIfAborted();
  // The scheduler fences new work; accepted persistence keeps independent custody.
  return owner.work.track(run);
}

/** Fence synchronously, then join accepted work before its worker transports close. */
export function closeAuthProfileUsage(host: LegacyPluginSdkResourceHost): Promise<void> {
  const owner = usageWork(host);
  owner.closing = true;
  return (owner.settled ??= AsyncWorkScope.runWhenAllIdle(
    () => [owner.work],
    () => owner.work.drain(),
  ));
}
