import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import type {
  ModelFallbackRuntimeContext,
  ModelFallbackRunFn,
  ModelFallbackErrorHandler,
  ModelFallbackStepHandler,
  ModelFallbackResultClassifier,
} from "./model-fallback-attempt.js";
import type {
  ModelFallbackCandidate,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

export type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  /** Keeps a rate-limit fallback first for this session's next turns so the provider prompt cache stays warm. */
  stickyRateLimitFallback?: boolean;
  userLockedAuthProfileId?: string;
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
  modelPolicy?: PreparedOperatorModelPolicy;
} & ModelManifestNormalizationContext;
