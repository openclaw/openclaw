import { type Mock } from "vitest";
import type { resolveProviderHttpRequestConfig, sanitizeConfiguredModelProviderRequest } from "../provider-http.js";
type ResolveProviderHttpRequestConfigParams = Parameters<typeof resolveProviderHttpRequestConfig>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<typeof sanitizeConfiguredModelProviderRequest>[0];
type ResolveProviderHttpRequestConfigResult = {
    baseUrl: string;
    allowPrivateNetwork: boolean;
    headers: Headers;
    dispatcherPolicy: undefined;
};
type AnyMock = Mock<(...args: unknown[]) => unknown>;
interface ProviderHttpMocks {
    resolveApiKeyForProviderMock: Mock<() => Promise<{
        apiKey: string;
    }>>;
    executeProviderOperationWithRetryMock: AnyMock;
    postJsonRequestMock: AnyMock;
    postMultipartRequestMock: AnyMock;
    fetchWithTimeoutMock: AnyMock;
    fetchWithTimeoutGuardedMock: AnyMock;
    pollProviderOperationJsonMock: AnyMock;
    assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
    assertOkOrThrowProviderErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
    sanitizeConfiguredModelProviderRequestMock: Mock<(request: SanitizeConfiguredModelProviderRequestParams) => SanitizeConfiguredModelProviderRequestParams>;
    resolveProviderHttpRequestConfigMock: Mock<(params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult>;
}
export declare function getProviderHttpMocks(): ProviderHttpMocks;
export declare function installProviderHttpMockCleanup(): void;
export {};
