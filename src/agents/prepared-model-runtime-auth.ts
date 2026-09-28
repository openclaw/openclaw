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
type RuntimeAuthBinding = {
  store?: AuthProfileStore;
  labels?: ModelCatalogAuthLabels;
  materializations?: readonly RuntimeAuthMaterialization[];
  load?: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
};
const runtimeAuth = new WeakMap<object, RuntimeAuthBinding>();
const authByFullCatalog = new WeakMap<
  object,
  {
    auth: PreparedModelCatalogAuth;
    readUsage?: (store: AuthProfileStore) => AuthProfileStore;
  }
>();

// Secret-bearing state stays lifecycle-owned without becoming part of the public snapshot shape.
export function bindPreparedModelRuntimeAuth(snapshot: object, binding: RuntimeAuthBinding): void {
  runtimeAuth.set(snapshot, { ...runtimeAuth.get(snapshot), ...binding });
}

export function getPreparedModelRuntimeAuthStore(snapshot: object): AuthProfileStore | undefined {
  return runtimeAuth.get(snapshot)?.store;
}

export function getPreparedModelRuntimeAuthLabels(snapshot: object): ModelCatalogAuthLabels {
  const labels = runtimeAuth.get(snapshot)?.labels;
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

export async function loadPreparedModelRuntimeAuth(
  snapshot: object & { authModes?: PreparedAgentCredentialModes },
  scope: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelRuntimeAuth | undefined> {
  const binding = runtimeAuth.get(snapshot);
  const load = binding?.load;
  if (load) {
    return await load(scope);
  }
  const authStore = binding?.store;
  return authStore ? { authStore, authModes: snapshot.authModes ?? {} } : undefined;
}

export function getPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
): readonly RuntimeAuthMaterialization[] {
  return runtimeAuth.get(snapshot)?.materializations ?? [];
}

export function copyPreparedModelRuntimeAuthBindings(source: object, target: object): void {
  const binding = runtimeAuth.get(source);
  if (binding) {
    bindPreparedModelRuntimeAuth(target, binding);
  }
}
