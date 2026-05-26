//#region src/provider-runtime/operation-retry.d.ts
type ProviderOperationRetryStage = "read" | "poll" | "download" | "create";
type TransientProviderRetryParams = {
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
  stage?: ProviderOperationRetryStage;
};
type TransientProviderRetryOptions = {
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
type TransientProviderRetryConfig = boolean | TransientProviderRetryOptions;
declare function providerOperationRetryConfig(stage: ProviderOperationRetryStage, options?: TransientProviderRetryConfig): TransientProviderRetryConfig | undefined;
declare function executeProviderOperationWithRetry<T>(params: {
  provider: string;
  stage: ProviderOperationRetryStage;
  operation: () => Promise<T>;
  retry?: TransientProviderRetryConfig;
}): Promise<T>;
//#endregion
export { executeProviderOperationWithRetry as a, TransientProviderRetryParams as i, TransientProviderRetryConfig as n, providerOperationRetryConfig as o, TransientProviderRetryOptions as r, ProviderOperationRetryStage as t };