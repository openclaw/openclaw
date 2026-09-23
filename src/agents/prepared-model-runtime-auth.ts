import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { isOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { hasOAuthIdentity } from "./auth-profiles/oauth-shared.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelRuntimeAuth = Readonly<{
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
}>;

export type PreparedModelCatalogAuth = PreparedModelRuntimeAuth &
  Readonly<{
    providerAuthLabels: ModelCatalogAuthLabels;
    /** Unobserved discovery credentials cannot authorize account-inventory retention. */
    credentials?: Readonly<AuthStorageData>;
  }>;

export type PreparedModelRuntimeAuthScope = Readonly<{
  providerIds: readonly string[];
  profileIds?: readonly string[];
}>;

/** Inventory follows identified accounts; credential use still follows the current auth owner. */
export function hasSamePreparedModelCatalogAuth(
  previous: Pick<PreparedModelCatalogAuth, "authStore" | "credentials"> | undefined,
  next: Pick<PreparedModelCatalogAuth, "authStore" | "credentials">,
  includesProvider: (provider: string) => boolean = () => true,
): boolean {
  if (!previous?.credentials || !next.credentials) {
    return false;
  }
  const identity = (authStore: AuthProfileStore, credentials: Readonly<AuthStorageData>) => {
    const profiles = Object.entries(authStore.profiles).filter(([, profile]) =>
      includesProvider(profile.provider),
    );
    const identifiedOAuth = profiles.filter(
      ([, profile]) =>
        profile.type === "oauth" && hasOAuthIdentity(profile) && !isOAuthRefreshFence(profile),
    );
    return {
      profiles: Object.fromEntries(
        profiles.map(([id, profile]) => {
          if (profile.type !== "oauth" || !identifiedOAuth.some(([key]) => key === id)) {
            return [id, profile];
          }
          const {
            access: _access,
            refresh: _refresh,
            expires: _expires,
            idToken: _idToken,
            ...account
          } = profile;
          return [id, account];
        }),
      ),
      credentials: Object.fromEntries(
        Object.entries(credentials)
          .filter(([provider]) => includesProvider(provider))
          .map(([provider, credential]) => {
            if (credential.type !== "oauth") {
              return [provider, credential];
            }
            const profileIds = identifiedOAuth
              .flatMap(([id, profile]) =>
                profile.type === "oauth" &&
                normalizeProviderId(profile.provider) === normalizeProviderId(provider) &&
                profile.access === credential.access &&
                profile.refresh === credential.refresh &&
                profile.expires === credential.expires
                  ? [id]
                  : [],
              )
              .toSorted();
            return [provider, profileIds.length ? { profileIds } : credential];
          }),
      ),
    };
  };
  return isDeepStrictEqual(
    identity(previous.authStore, previous.credentials),
    identity(next.authStore, next.credentials),
  );
}

/** Private auth facts owned by an immutable prepared model generation. */
const authStoreBySnapshot = new WeakMap<object, AuthProfileStore>();
const authLabelsBySnapshot = new WeakMap<object, ModelCatalogAuthLabels>();
const materializationsBySnapshot = new WeakMap<object, readonly RuntimeAuthMaterialization[]>();
const authLoaderBySnapshot = new WeakMap<
  object,
  (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>
>();
const authByFullCatalog = new WeakMap<
  object,
  {
    auth: PreparedModelCatalogAuth;
    readUsage?: (store: AuthProfileStore) => AuthProfileStore;
  }
>();

// Secret-bearing state stays lifecycle-owned without becoming part of the public snapshot shape.
export function setPreparedModelRuntimeAuthStore(
  snapshot: object,
  authStore: AuthProfileStore,
): void {
  authStoreBySnapshot.set(snapshot, authStore);
}

export function getPreparedModelRuntimeAuthStore(snapshot: object): AuthProfileStore | undefined {
  return authStoreBySnapshot.get(snapshot);
}

export function setPreparedModelRuntimeAuthLabels(
  snapshot: object,
  labels: ModelCatalogAuthLabels,
): void {
  authLabelsBySnapshot.set(snapshot, labels);
}

export function getPreparedModelRuntimeAuthLabels(snapshot: object): ModelCatalogAuthLabels {
  const labels = authLabelsBySnapshot.get(snapshot);
  if (!labels) {
    throw new Error("Prepared model runtime omitted auth display labels");
  }
  return labels;
}

export function setPreparedModelFullCatalogAuth(
  snapshot: object,
  auth: PreparedModelCatalogAuth,
  readUsage?: (store: AuthProfileStore) => AuthProfileStore,
): void {
  authByFullCatalog.set(snapshot, {
    auth,
    readUsage: readUsage ?? authByFullCatalog.get(snapshot)?.readUsage,
  });
}

export function getPreparedModelFullCatalogAuth(snapshot: object) {
  const binding = authByFullCatalog.get(snapshot);
  if (!binding) {
    return undefined;
  }
  const authStore = binding.readUsage?.(binding.auth.authStore) ?? binding.auth.authStore;
  return authStore === binding.auth.authStore ? binding.auth : { ...binding.auth, authStore };
}

export function copyPreparedModelFullCatalogAuth(source: object, target: object): void {
  const binding = authByFullCatalog.get(source);
  if (binding) {
    authByFullCatalog.set(target, binding);
  }
}

export function setPreparedModelRuntimeAuthLoader(
  snapshot: object,
  loader: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>,
): void {
  authLoaderBySnapshot.set(snapshot, loader);
}

export async function loadPreparedModelRuntimeAuth(
  snapshot: object & { authModes?: PreparedAgentCredentialModes },
  scope: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelRuntimeAuth | undefined> {
  const loader = authLoaderBySnapshot.get(snapshot);
  if (loader) {
    return await loader(scope);
  }
  const authStore = authStoreBySnapshot.get(snapshot);
  return authStore ? { authStore, authModes: snapshot.authModes ?? {} } : undefined;
}

export function setPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
  materializations: readonly RuntimeAuthMaterialization[],
): void {
  materializationsBySnapshot.set(snapshot, materializations);
}

export function getPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
): readonly RuntimeAuthMaterialization[] {
  return materializationsBySnapshot.get(snapshot) ?? [];
}

export function copyPreparedModelRuntimeAuthBindings(source: object, target: object): void {
  const authStore = authStoreBySnapshot.get(source);
  const labels = authLabelsBySnapshot.get(source);
  const authLoader = authLoaderBySnapshot.get(source);
  const materializations = materializationsBySnapshot.get(source);
  if (authStore) {
    authStoreBySnapshot.set(target, authStore);
  }
  if (labels) {
    authLabelsBySnapshot.set(target, labels);
  }
  if (authLoader) {
    authLoaderBySnapshot.set(target, authLoader);
  }
  if (materializations) {
    materializationsBySnapshot.set(target, materializations);
  }
}
