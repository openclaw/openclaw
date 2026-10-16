import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { nativePluginBindings } from "../plugins/loader-runtime-load.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { discoverAuthStorageFacts } from "./agent-model-discovery.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";
import type { PreparedModelRuntimeAgentBaseFacts } from "./prepared-model-runtime.catalog-contract.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeCatalogMode,
} from "./prepared-model-runtime.types.js";

export async function prepareAgentFacts(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode,
  ambientCredentials: Readonly<AgentCredentialMap>,
  assertCurrent: () => void,
  additionalProviderIds: readonly string[] = [],
  includeCredentialProviders = catalogMode === "live",
): Promise<PreparedModelRuntimeAgentBaseFacts> {
  const env = input.env ?? process.env;
  const preparedStore = await nativePluginBindings.authStore.prepareAuthProfileStoreForModelRuntime(
    input.agentDir,
    {
      config: input.config,
      inheritedAuthDir: input.inheritedAuthDir,
      skipCredentials: input.skipCredentials,
    },
    assertCurrent,
    env,
  );
  assertCurrent();
  const authFacts = await discoverAuthStorageFacts(input.agentDir, {
    config: input.config,
    // Prepared owners consume only the already-published runtime auth generation. External CLI
    // hydration belongs to startup/control-plane and turn-time producers, never rebuilds.
    readOnly: true,
    ambientCredentials,
    ...(preparedStore ? { preparedStore } : {}),
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  return withAgentRosterFactsBatch(input.config, () => {
    const credentials = authFacts.credentials;
    const templateAuthStorage = authFacts.authStorage;
    const rawConfiguredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
      input.config,
      input.agentId,
      input.readOnly ? input.runtimePluginSelections : undefined,
    );
    return {
      input,
      env,
      authStore: authFacts.store,
      templateAuthStorage,
      credentials,
      // Keep order and case-distinct refs: registry lookup remains exact-case even
      // where static/dynamic completion deduplicates case-insensitive merge keys.
      configuredModelRefs: rawConfiguredModelRefs.flatMap(({ value }) => {
        const ref = parseModelCatalogRef(value);
        return ref ? [ref] : [];
      }),
      // Gateway startup prepares only providers named by config/model selection. An unrelated
      // stored credential must not pull that provider's complete catalog into the admission path.
      providerIds: [
        ...new Set([
          ...collectPreparedModelRuntimeProviderIds(
            input.config,
            credentials,
            includeCredentialProviders,
            rawConfiguredModelRefs,
            input.agentId,
          ),
          ...parseConfiguredModelVisibilityEntries({
            cfg: input.config,
            agentId: input.agentId,
          }).providerWildcards,
          ...additionalProviderIds.map(normalizeProviderId).filter(Boolean),
        ]),
      ].toSorted((left, right) => left.localeCompare(right)),
    };
  });
}
