import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import type { ModelCatalogEntry } from "./model-catalog-entry.types.js";

export type { ModelCatalogEntry, ModelInputType } from "./model-catalog-entry.types.js";

/** Logical catalog rows plus the physical variants used for route selection. */
export type ModelCatalogSnapshot = {
  entries: ModelCatalogEntry[];
  routeVariants: ModelCatalogEntry[];
  /** Provider-owned outcome of each live catalog request in this generation. */
  providerOutcomes?: readonly ProviderCatalogOutcome[];
  /** Previously accepted inventory remains bound to these provider/profile identities. */
  acceptedDiscoveryOrigins?: readonly Pick<ProviderCatalogOutcome, "provider" | "profileId">[];
  /** Native discovery facts belong to their harness, independently of API-provider auth. */
  nativeProviderOutcomes?: Readonly<Record<string, readonly ProviderCatalogOutcome[]>>;
  /** Untagged harness observations, before API donor enrichment; each runtime owns its scope. */
  nativeHostRows?: Readonly<Record<string, readonly ModelCatalogEntry[]>>;
  /** The current acquisition failed while this published inventory remained available. */
  refreshFailed?: boolean;
  /** Failed discovery scopes, never errors, credentials, endpoints, or account/profile ids. */
  refreshFailures?: readonly {
    acquisition: "provider" | "native";
    /** Omitted when the failed acquisition could not identify its provider scope. */
    provider?: string;
  }[];
  /** Provider discovery is in progress; existing rows remain usable. */
  pendingProviders?: readonly string[];
  /** Static provider-hook rows captured alongside the full lifecycle generation. */
  staticEntries?: ModelCatalogEntry[];
  /**
   * `false` only when this snapshot came from a degraded load (discovery threw,
   * static or empty fallback). Absent/`true` means authoritative — consumers that
   * destroy durable state (e.g. resetting a pinned model override) must treat only
   * an explicit `false` as degraded, so unrelated hand-built snapshots stay safe.
   */
  authoritative?: boolean;
};
