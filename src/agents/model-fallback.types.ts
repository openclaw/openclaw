import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { FailoverReason } from "./failover/signal.js";

export const MODEL_FALLBACK_SKIPPED_CODE = "MODEL_FALLBACK_SKIPPED";

export type ModelCandidate = ProviderModelRef;

export type ModelFallbackAvailability =
  // `source` records whether an explicit fallbacks override owns the ladder or the
  // models were inherited from defaults; the run-override projection depends on it.
  | { kind: "active"; models: string[]; source: "explicit" | "inherited" }
  | { kind: "none_configured"; source: "explicit" | "inherited" }
  | { kind: "disabled_by_model_override" }
  | { kind: "disabled_by_model_selection_lock" };

export type ModelFallbackRouteOrigin = "requested" | "configured-fallback" | "configured-primary";
export type ModelFallbackRouteResolution = "raw" | "resolved";

/** A runnable route plus the selection edge and resolution state it arrived with. */
export type ModelFallbackCandidate = ModelCandidate & {
  routeOrigin: ModelFallbackRouteOrigin;
  routeResolution: ModelFallbackRouteResolution;
};

export type FallbackAttempt = ModelCandidate & {
  error: string;
  rateLimitRetriesExhausted?: number;
  reason?: FailoverReason;
  authMode?: string;
  status?: number;
  code?: string;
};

/** Original route plus the outer fallback stage that admitted one real attempt. */
export type ModelFallbackAttemptProvenance = {
  requestedProvider: string;
  requestedModel: string;
  stage: "initial" | "fallback";
  /** A user switch invalidates automatic routing for the original selection for this cycle. */
  selectionChanged?: boolean;
  fallbackReason?: FailoverReason;
};
