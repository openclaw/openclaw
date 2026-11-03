import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteAuthRequirement,
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
} from "../plugin-sdk/provider-model-types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { SelectedModelCredential } from "./model-auth-selected-credential.js";
import type { CliRuntimeAuthDirectories } from "./model-runtime-aliases.js";
import type { createOpenAIModelRoutesResolver } from "./openai-model-routes.js";
import type { ProviderModelAuthEvidence } from "./provider-model-auth-source-plan.js";

export type ModelAuthAvailability = boolean | undefined;
export type ModelAuthAvailabilityEvidence = Exclude<ProviderModelAuthEvidence, "none">;
export type ModelAuthAvailabilityRef = {
  /** Concrete runtime selected by the model decision owner; absent means provider auth only. */
  runtimeId?: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  /** All physical route rows observed for this logical provider/model pair. */
  observedRoutes?: readonly ProviderModelRouteSource[];
  /** Automatic session preference; considered before the configured profile order. */
  preferredProfileId?: string;
  /** Explicit session preference, including profiles outside the shared order. */
  pinnedProfileId?: string;
  /** Runtime-owned account boundary that forbids shared profile failover. */
  requiredProfileId?: string;
};
export type ModelAuthAvailabilityEvaluation = {
  requestedRuntimeId?: string;
  availability: ModelAuthAvailability;
  /** A route/account or runtime-owned result must not fall back to provider-only registry auth. */
  availabilityAuthoritative?: true;
  unavailableReason?: "missing-auth" | "auth-failed" | "cooldown";
  /** Earliest known retry time, in milliseconds since the Unix epoch. */
  unavailableUntil?: number;
  routeResolution: ProviderModelRouteResolution | null;
  selectedRoute?: ProviderModelRouteCandidate;
  selectedProfileId?: string;
  selectedAuthMode?: string;
  selectedCredential?: SelectedModelCredential;
  evidence?: ModelAuthAvailabilityEvidence;
  runtimeAuth?: { id: string; source: "native" };
};
export type ModelAuthAvailabilityResolver = {
  evaluateRuntimeModelAuth(
    this: void,
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): ModelAuthAvailabilityEvaluation;
  providerDiscoveryProviderIds: readonly string[];
  evaluateModelAuth(
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): ModelAuthAvailabilityEvaluation;
  resolveProviderAuthAvailability(
    provider: string,
    ref?: ModelAuthAvailabilityRef,
  ): ModelAuthAvailability;
};

export type CreateModelAuthAvailabilityResolverParams = {
  evaluatePluginAuth?: (
    provider: string,
    ref: ModelAuthAvailabilityRef,
  ) => ModelAuthAvailabilityEvaluation;
  cfg: OpenClawConfig;
  preparedCliRuntimeAuthDirectories?: CliRuntimeAuthDirectories;
  agentId?: string;
  authStore: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
  externalCliProviderIds?: readonly string[];
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  preparedRuntimeAuthStore?: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  /**
   * Ids the credential's own ready account listing returned, including hidden rows; absent when
   * that credential has no ready listing. Another account's listing says nothing about this one.
   */
  accountListedModelIds?: (
    provider: string,
    profileId: string | undefined,
  ) => ReadonlySet<string> | undefined;
};

export type AuthTarget = ModelAuthAvailabilityRef & {
  authRequirement?: ProviderModelRouteAuthRequirement;
};
export type AuthSourceEvaluation = Pick<
  ModelAuthAvailabilityEvaluation,
  | "availability"
  | "selectedAuthMode"
  | "evidence"
  | "selectedProfileId"
  | "unavailableReason"
  | "unavailableUntil"
>;
