import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { AgentTerminalSnapshot } from "./agent-terminal-snapshot.js";
import type { FailoverReason } from "./failover/signal.js";
import type {
  ModelFallbackRuntimeContext,
  ModelFallbackRunFn,
  ModelFallbackErrorHandler,
  ModelFallbackStepHandler,
  ModelFallbackResultClassifier,
} from "./model-fallback-attempt.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";

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

export type ModelFallbackResultClassification =
  | {
      agentTerminal?: AgentTerminalSnapshot;
      message: string;
      reason?: FailoverReason;
      status?: number;
      code?: string;
      rawError?: string;
      rateLimitRetriesExhausted?: number;
      preserveResultOnExhaustion?: boolean;
      preserveResultPriority?: number;
    }
  | { error: unknown }
  | null
  | undefined;

export type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  /** Keeps a rate-limit fallback first for this session's next turns so the provider prompt cache stays warm. */
  stickyRateLimitFallback?: boolean;
  userLockedAuthProfileId?: string;
  admitCandidate?: (provider: string, model: string) => Promise<string | undefined>;
  resolveCandidateAuthProfileId?: (provider: string, model: string) => string | undefined;
  prepareCandidateChain?: (candidates: readonly ModelFallbackCandidate[]) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (
    attempt: Parameters<ModelFallbackErrorHandler>[0],
  ) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  /** The attempt owner admits its runtime and selects credentials. */
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
} & ModelManifestNormalizationContext;
