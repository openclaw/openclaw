type ApiKeyRetryParams = {
    apiKey: string;
    error: unknown;
    attempt: number;
};
type ExecuteWithApiKeyRotationOptions<T> = {
    provider: string;
    apiKeys: string[];
    execute: (apiKey: string) => Promise<T>;
    shouldRetry?: (params: ApiKeyRetryParams & {
        message: string;
    }) => boolean;
    onRetry?: (params: ApiKeyRetryParams & {
        message: string;
    }) => void;
};
export declare function collectProviderApiKeysForExecution(params: {
    provider: string;
    primaryApiKey?: string;
}): string[];
export declare function executeWithApiKeyRotation<T>(params: ExecuteWithApiKeyRotationOptions<T>): Promise<T>;
export {};
