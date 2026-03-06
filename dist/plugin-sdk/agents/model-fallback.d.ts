import type { OpenClawConfig } from "../config/config.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
type FallbackAttempt = {
    provider: string;
    model: string;
    error: string;
    reason?: FailoverReason;
    status?: number;
    code?: string;
};
type ModelFallbackErrorHandler = (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
}) => void | Promise<void>;
type ModelFallbackRunResult<T> = {
    result: T;
    provider: string;
    model: string;
    attempts: FallbackAttempt[];
};
declare function resolveProbeThrottleKey(provider: string, agentDir?: string): string;
/** @internal – exposed for unit tests only */
export declare const _probeThrottleInternals: {
    readonly lastProbeAttempt: Map<string, number>;
    readonly MIN_PROBE_INTERVAL_MS: 30000;
    readonly PROBE_MARGIN_MS: number;
    readonly resolveProbeThrottleKey: typeof resolveProbeThrottleKey;
};
export declare function runWithModelFallback<T>(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    agentDir?: string;
    /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
    fallbacksOverride?: string[];
    run: (provider: string, model: string) => Promise<T>;
    onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>>;
export declare function runWithImageModelFallback<T>(params: {
    cfg: OpenClawConfig | undefined;
    modelOverride?: string;
    run: (provider: string, model: string) => Promise<T>;
    onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>>;
export {};
