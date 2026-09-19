import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import type { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import type {
  PreparedModelRuntimeAuth,
  PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

export function createPreparedModelCatalogAuthLoader(params: {
  agentFacts: Pick<PreparedModelRuntimeAgentFacts, "credentials">;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  assertCurrent: () => void;
  worker: Pick<ReturnType<typeof createPreparedModelCatalogWorker>, "loadAuth">;
}) {
  let pendingAuth: { key: string; promise: Promise<PreparedModelRuntimeAuth> } | undefined;
  return async ({
    providerIds,
    profileIds,
  }: PreparedModelRuntimeAuthScope): Promise<PreparedModelRuntimeAuth> => {
    params.assertCurrent();
    const cacheKey = [providerIds, profileIds ?? []]
      .map((ids) =>
        [...new Set(ids)].toSorted((left, right) => left.localeCompare(right)).join("\0"),
      )
      .join("\0\0");
    if (pendingAuth?.key === cacheKey) {
      return pendingAuth.promise;
    }
    const promise = (async () => {
      await using _ = {
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
      };
      return await params.worker
        .loadAuth({ providerIds, ...(profileIds?.length ? { profileIds } : {}) })
        .then((refreshed) => {
          const authModes = {
            ...resolveUsableAgentCredentialModes(params.agentFacts.credentials),
          };
          for (const providerId of [
            ...providerIds,
            ...scopeSyntheticAuthProviderRefs(Object.keys(authModes), providerIds),
          ]) {
            delete authModes[normalizeProviderId(providerId)];
          }
          Object.assign(authModes, refreshed.authModes);
          return { authStore: refreshed.authStore, authModes: Object.freeze(authModes) };
        });
    })().finally(() => {
      if (pendingAuth?.promise === promise) {
        pendingAuth = undefined;
      }
    });
    pendingAuth = { key: cacheKey, promise };
    return promise;
  };
}
