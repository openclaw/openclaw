import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ModelFallbackStepFields } from "./model-fallback-observation.js";
import type { FallbackAttempt } from "./model-fallback.types.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
type FailoverAttribution = {
    sessionId?: string;
    lane?: string;
};
/**
 * Structured error thrown when all model fallback candidates have been
 * exhausted. Carries per-attempt details so callers can build informative
 * user-facing messages (e.g. "rate-limited, retry in 30 s").
 */
export declare class FallbackSummaryError extends Error {
    readonly attempts: FallbackAttempt[];
    readonly soonestCooldownExpiry: number | null;
    readonly sessionId?: string;
    readonly lane?: string;
    constructor(message: string, attempts: FallbackAttempt[], soonestCooldownExpiry: number | null, cause?: Error, attribution?: FailoverAttribution);
}
export declare function isFallbackSummaryError(err: unknown): err is FallbackSummaryError;
export type ModelFallbackRunOptions = {
    allowTransientCooldownProbe?: boolean;
};
type ModelFallbackRunFn<T> = (provider: string, model: string, options?: ModelFallbackRunOptions) => Promise<T>;
type ModelFallbackErrorHandler = (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
}) => void | Promise<void>;
type ModelFallbackStepHandler = (step: ModelFallbackStepFields) => void | Promise<void>;
export type ModelFallbackResultClassification = {
    message: string;
    reason?: FailoverReason;
    status?: number;
    code?: string;
    rawError?: string;
} | {
    error: unknown;
} | null | undefined;
type ModelFallbackResultClassifier<T> = (attempt: {
    result: T;
    provider: string;
    model: string;
    attempt: number;
    total: number;
}) => ModelFallbackResultClassification | Promise<ModelFallbackResultClassification>;
type ModelFallbackRunResult<T> = {
    result: T;
    provider: string;
    model: string;
    attempts: FallbackAttempt[];
};
declare function resolveProbeThrottleKey(provider: string, agentDir?: string): string;
declare function pruneProbeState(now: number): void;
declare function isProbeThrottleOpen(now: number, throttleKey: string): boolean;
declare function markProbeAttempt(now: number, throttleKey: string): void;
/** @internal – exposed for unit tests only */
export declare const _probeThrottleInternals: {
    readonly lastProbeAttempt: Map<string, number>;
    readonly MIN_PROBE_INTERVAL_MS: 30000;
    readonly PROBE_MARGIN_MS: number;
    readonly PROBE_STATE_TTL_MS: number;
    readonly MAX_PROBE_KEYS: 256;
    readonly resolveProbeThrottleKey: typeof resolveProbeThrottleKey;
    readonly isProbeThrottleOpen: typeof isProbeThrottleOpen;
    readonly pruneProbeState: typeof pruneProbeState;
    readonly markProbeAttempt: typeof markProbeAttempt;
};
export declare function runWithModelFallback<T>(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    runId?: string;
    sessionId?: string;
    lane?: string;
    agentDir?: string;
    /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
    fallbacksOverride?: string[];
    run: ModelFallbackRunFn<T>;
    onError?: ModelFallbackErrorHandler;
    onFallbackStep?: ModelFallbackStepHandler;
    classifyResult?: ModelFallbackResultClassifier<T>;
}): Promise<ModelFallbackRunResult<T>>;
export declare function runWithImageModelFallback<T>(params: {
    cfg: OpenClawConfig | undefined;
    modelOverride?: string;
    run: (provider: string, model: string) => Promise<T>;
    onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>>;
export {};
