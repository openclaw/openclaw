import type { PluginRegistry } from "../plugins/registry-types.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type {
  PreparedModelRuntimeInput,
  PreparedNativeModelSelection,
} from "./prepared-model-runtime.types.js";

export type NativeCatalogDiscoveryFailure = {
  error: unknown;
  providers?: readonly string[];
};

export type NativeCatalogRows = {
  rawCatalog: ModelCatalogSnapshot;
  completed: boolean;
  discoveredProviders: string[];
  failures: NativeCatalogDiscoveryFailure[];
};

export type NativeCatalogRowsContext = {
  input: PreparedModelRuntimeInput;
  selection?: PreparedNativeModelSelection;
  isCurrent: () => boolean;
  getPublishedCatalog: () => ModelCatalogSnapshot;
  readCatalog: () => ModelCatalogSnapshot;
  normalizeProvider: (provider: string) => string;
  pluginRegistry?: PluginRegistry;
  providerIds?: readonly string[];
  agentProviderIds: readonly string[];
  attempt: {
    setPending: (providers: readonly string[] | undefined, kind: "native") => void;
  };
};

/**
 * Runs one native catalog discovery through the agent harness and reports
 * what it found: the raw catalog, whether discovery completed, the newly
 * discovered providers, and any per-provider failures.
 */
export async function acquireNativeCatalogRows(
  ctx: NativeCatalogRowsContext,
): Promise<NativeCatalogRows> {
  const failures: NativeCatalogDiscoveryFailure[] = [];
  let completed = false;
  let discoveredProviders: string[] = [];
  const providerIds = ctx.providerIds;
  const startupProviders = new Set(ctx.agentProviderIds.map(ctx.normalizeProvider));
  const rawCatalog = await augmentPreparedModelCatalogWithAgentHarness({
    input: ctx.input,
    nativeSelection: ctx.selection,
    snapshot: ctx.isCurrent() ? ctx.getPublishedCatalog() : ctx.readCatalog(),
    normalizeProvider: ctx.normalizeProvider,
    preparedSnapshot: ctx.readCatalog(),
    pluginRegistry: ctx.pluginRegistry,
    includesProvider: providerIds
      ? (provider) => providerIds.includes(ctx.normalizeProvider(provider))
      : undefined,
    onDiscoveryStarted: (provider) => {
      ctx.attempt.setPending([ctx.normalizeProvider(provider)], "native");
    },
    onError: (error, failedProviderIds) => {
      failures.push({ error, providers: failedProviderIds?.map(ctx.normalizeProvider) });
    },
    onDiscoveryCompleted: (rows) => {
      completed = true;
      discoveredProviders = [
        ...new Set(
          rows
            .map((entry) => ctx.normalizeProvider(entry.provider))
            .filter((provider) => !startupProviders.has(provider)),
        ),
      ];
    },
  });
  return { rawCatalog, completed, discoveredProviders, failures };
}
