import type { resolveProviderHttpRequestConfig, sanitizeConfiguredModelProviderRequest } from "../provider-http.js";
type ResolveProviderHttpRequestConfigParams = Parameters<typeof resolveProviderHttpRequestConfig>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<typeof sanitizeConfiguredModelProviderRequest>[0];
export declare function getProviderHttpMocks(): {
    resolveApiKeyForProviderMock: import("vitest").Mock<() => Promise<{
        apiKey: string;
    }>>;
    postJsonRequestMock: import("vitest").Mock<import("@vitest/spy").Procedure>;
    fetchWithTimeoutMock: import("vitest").Mock<import("@vitest/spy").Procedure>;
    pollProviderOperationJsonMock: import("vitest").Mock<import("@vitest/spy").Procedure>;
    assertOkOrThrowHttpErrorMock: import("vitest").Mock<(_response: Response, _label: string) => Promise<void>>;
    assertOkOrThrowProviderErrorMock: import("vitest").Mock<(_response: Response, _label: string) => Promise<void>>;
    sanitizeConfiguredModelProviderRequestMock: import("vitest").Mock<(request: SanitizeConfiguredModelProviderRequestParams) => import("../config-types.ts").ConfiguredModelProviderRequest | undefined>;
    resolveProviderHttpRequestConfigMock: import("vitest").Mock<(params: ResolveProviderHttpRequestConfigParams) => {
        baseUrl: string;
        allowPrivateNetwork: boolean;
        headers: Headers;
        dispatcherPolicy: undefined;
    }>;
};
export declare function installProviderHttpMockCleanup(): void;
export {};
