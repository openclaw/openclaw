export type ProviderOperationRetryStage = "read" | "poll" | "download" | "create";
export type TransientProviderRetryParams = {
    error: unknown;
    message: string;
    provider: string;
    apiKeyIndex: number;
    attemptNumber: number;
    stage?: ProviderOperationRetryStage;
};
export type TransientProviderRetryOptions = {
    /**
     * Total executions, including the first call.
     * attempts: 2 means one initial call plus one retry.
     */
    attempts: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    signal?: AbortSignal;
    shouldRetry?: (params: TransientProviderRetryParams) => boolean;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
export type TransientProviderRetryConfig = boolean | TransientProviderRetryOptions;
export declare const DEFAULT_TRANSIENT_PROVIDER_RETRY_OPTIONS: {
    readonly attempts: 2;
    readonly baseDelayMs: 250;
    readonly maxDelayMs: 1000;
};
export declare function resolveTransientProviderRetryOptions(options?: TransientProviderRetryConfig): TransientProviderRetryOptions | undefined;
export declare function defaultTransientProviderRetryForStage(stage: ProviderOperationRetryStage): TransientProviderRetryConfig | undefined;
export declare function providerOperationRetryConfig(stage: ProviderOperationRetryStage, options?: TransientProviderRetryConfig): TransientProviderRetryConfig | undefined;
export declare function isTransientProviderOperationError(error: unknown, message: string): boolean;
export declare function resolveTransientProviderAttempts(options?: TransientProviderRetryOptions): number;
export declare function resolveTransientProviderDelayMs(options: TransientProviderRetryOptions, attemptNumber: number): number;
export declare function shouldRetrySameKeyProviderOperation(params: {
    options: TransientProviderRetryOptions;
    error: unknown;
    message: string;
    provider: string;
    apiKeyIndex: number;
    attemptNumber: number;
    maxAttempts: number;
    stage?: ProviderOperationRetryStage;
}): boolean;
export declare function executeProviderOperationWithRetry<T>(params: {
    provider: string;
    stage: ProviderOperationRetryStage;
    operation: () => Promise<T>;
    retry?: TransientProviderRetryConfig;
}): Promise<T>;
