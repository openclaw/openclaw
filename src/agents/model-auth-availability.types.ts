import type {
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
} from "../plugin-sdk/provider-model-types.js";
import type { SelectedModelCredential } from "./model-auth-selected-credential.js";
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
