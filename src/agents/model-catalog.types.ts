import type {
  ModelCatalogContextWindowOption,
  ModelCatalogStatus,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import type { ThinkingLevelMap } from "../llm/types.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";

export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

export type ModelCatalogEntry = {
  /** Native catalog owner, not a physical provider route or transferable readiness fact. */
  nativeRuntime?: string;
  id: string;
  name: string;
  provider: string;
  /** Provider-owned strongest-first picker order; internal and never projected to clients. */
  providerOrder?: number;
  alias?: string;
  api?: ModelApi;
  /** Private transport provenance for route matching; never project directly to clients. */
  baseUrl?: string;
  contextWindow?: number;
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  /** Visible failed-acquisition starter; sizing comes from current static or accepted owner facts. */
  contextCapacitySource?: "unaccepted-starter";
  /** Provider-declared unknown-model estimate; not an authored or curated static limit. */
  contextWindowSource?: "synthetic";
  reasoning?: boolean;
  /** Config-authored reasoning override; internal provenance, never project to clients. */
  configuredReasoning?: boolean;
  /** Concrete runtime owner of thinking policy; internal and never project to clients. */
  thinkingPolicyProvider?: string;
  /** Provider-owned effort support for this exact physical model route. */
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ModelInputType[];
  params?: Record<string, unknown>;
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
};

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
