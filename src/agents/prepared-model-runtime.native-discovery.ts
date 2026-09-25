import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedNativeModelSelection } from "./prepared-model-runtime.types.js";

export type PreparedNativeSelectionDiscoveryStatus = {
  outcomes: readonly ProviderCatalogOutcome[];
  failedProviders: readonly string[];
  unknownProviderFailure: boolean;
};

export function createPreparedNativeSelectionDiscoveryStatus(params: {
  catalog: ModelCatalogSnapshot;
  selection: PreparedNativeModelSelection | undefined;
  failures: readonly { providers?: readonly string[] }[];
  normalizeProvider: (provider: string) => string;
}): PreparedNativeSelectionDiscoveryStatus {
  return {
    outcomes: params.selection
      ? (params.catalog.nativeProviderOutcomes?.[params.selection.runtime] ?? [])
      : [],
    failedProviders: params.failures.flatMap(({ providers }) =>
      (providers ?? []).map(params.normalizeProvider),
    ),
    unknownProviderFailure: params.failures.some(({ providers }) => providers === undefined),
  };
}

export function isPreparedNativeSelectionDiscoveryReady(params: {
  rows: readonly ModelCatalogEntry[];
  selection: PreparedNativeModelSelection;
  status: PreparedNativeSelectionDiscoveryStatus;
  normalizeProvider: (provider: string) => string;
}): boolean {
  const selectedProvider = params.normalizeProvider(params.selection.provider);
  return (
    params.rows.some(
      (entry) =>
        params.normalizeProvider(entry.provider) === selectedProvider &&
        entry.id === params.selection.modelId &&
        entry.nativeRuntime === params.selection.runtime,
    ) &&
    !params.status.unknownProviderFailure &&
    !params.status.failedProviders.includes(selectedProvider) &&
    !params.status.outcomes.some(
      (outcome) =>
        params.normalizeProvider(outcome.provider) === selectedProvider &&
        outcome.status !== "ready",
    )
  );
}
