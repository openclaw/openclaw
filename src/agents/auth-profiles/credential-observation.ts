import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AuthProfileCredential } from "./types.js";

export type CanonicalAuthProfileCredentialObservation = {
  databasePath: string;
  profiles: Readonly<Record<string, AuthProfileCredential>>;
};

type Observer = (observation: CanonicalAuthProfileCredentialObservation) => void;
type ObserverScope = { observer: Observer | undefined; parent?: ObserverScope };
// Unlike runtime profile IDs, these private receipts identify exact canonical bytes.
// They survive only their credential objects and never replace the publication-time reread.
type CredentialOrigin = {
  databasePath: string;
  profileId: string;
  serialized: string;
};

// Host and bundled SDK auth resolution must report to the same request scope.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.canonicalAuthCredentialObservation"),
  () => ({
    scope: new AsyncLocalStorage<ObserverScope>(),
    origins: new WeakMap<AuthProfileCredential, readonly CredentialOrigin[]>(),
  }),
);

export async function withCanonicalAuthProfileCredentialObserver<T>(
  observer: Observer,
  run: () => Promise<T>,
): Promise<T> {
  const scope: ObserverScope = { observer, parent: state.scope.getStore() };
  try {
    return await state.scope.run(scope, run);
  } finally {
    scope.observer = undefined;
  }
}

function publish(databasePath: string, profiles: Readonly<Record<string, AuthProfileCredential>>) {
  let scope = state.scope.getStore();
  // Detached work from a completed inner scope cannot append to its parent either.
  if (!scope?.observer || Object.keys(profiles).length === 0) {
    return;
  }
  while (scope) {
    scope.observer?.({ databasePath, profiles: structuredClone(profiles) });
    scope = scope.parent;
  }
}

/** Observe an existing canonical read or committed credential, never a runtime overlay. */
export function observeCanonicalAuthProfileCredentials(
  databasePath: string,
  profiles: Readonly<Record<string, AuthProfileCredential>>,
): void {
  for (const [profileId, credential] of Object.entries(profiles)) {
    const previous = state.origins.get(credential) ?? [];
    state.origins.set(credential, [
      ...previous.filter(
        (origin) => origin.databasePath !== databasePath || origin.profileId !== profileId,
      ),
      { databasePath, profileId, serialized: JSON.stringify(credential) },
    ]);
  }
  publish(databasePath, profiles);
}

/** Cloning preserves evidence only for the exact credential bytes the owner observed. */
export function copyCanonicalAuthProfileCredentialObservations(
  source: Readonly<Record<string, AuthProfileCredential>>,
  target: Readonly<Record<string, AuthProfileCredential>>,
): void {
  for (const [profileId, credential] of Object.entries(target)) {
    const original = source[profileId];
    if (!original) {
      continue;
    }
    const origins = state.origins
      .get(original)
      ?.filter(
        (origin) =>
          origin.profileId === profileId && origin.serialized === JSON.stringify(credential),
      );
    if (origins?.length) {
      state.origins.set(credential, origins);
    }
  }
}

/** Cached reads replay producer facts, not profile IDs or inferred directory ownership. */
export function observeCachedCanonicalAuthProfileCredentials(
  profiles: Readonly<Record<string, AuthProfileCredential>>,
): void {
  if (!state.scope.getStore()?.observer) {
    return;
  }
  const byOwner = new Map<string, Map<string, AuthProfileCredential>>();
  for (const [profileId, credential] of Object.entries(profiles)) {
    for (const origin of state.origins.get(credential) ?? []) {
      if (origin.profileId !== profileId || origin.serialized !== JSON.stringify(credential)) {
        continue;
      }
      const owned = byOwner.get(origin.databasePath) ?? new Map<string, AuthProfileCredential>();
      owned.set(profileId, credential);
      byOwner.set(origin.databasePath, owned);
    }
  }
  for (const [databasePath, owned] of byOwner) {
    publish(databasePath, Object.fromEntries(owned));
  }
}
