import { AsyncLocalStorage } from "node:async_hooks";
import {
  getBoundLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";

const acceptedUsage = new AsyncLocalStorage<UsageWork>();

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
  const inherited = acceptedUsage.getStore();
  const alreadyAccepted = inherited === owner;
  if (owner.closing && !alreadyAccepted) {
    throw new Error("Auth profile usage owner is closed");
  }
  if (!alreadyAccepted) {
    host.scheduler.signal.throwIfAborted();
  }
  return owner.work.track(() => acceptedUsage.run(owner, run));
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
