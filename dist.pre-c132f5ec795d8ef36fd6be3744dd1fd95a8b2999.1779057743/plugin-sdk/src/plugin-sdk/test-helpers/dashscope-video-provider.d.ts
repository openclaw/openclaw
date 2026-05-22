import type { VideoGenerationResult } from "../video-generation.js";
type ClearableMock = {
    mockClear(): unknown;
};
type ResettableMock = {
    mockReset(): unknown;
};
type ResolvableMock = {
    mockResolvedValue(value: unknown): unknown;
};
type ChainableResolvedValueMock = ResettableMock & {
    mockResolvedValueOnce(value: unknown): ChainableResolvedValueMock;
};
export type DashscopeVideoProviderMocks = {
    resolveApiKeyForProviderMock: ClearableMock;
    postJsonRequestMock: ResettableMock & ResolvableMock;
    fetchWithTimeoutMock: ChainableResolvedValueMock;
    assertOkOrThrowHttpErrorMock: ClearableMock;
    resolveProviderHttpRequestConfigMock: ClearableMock;
};
export declare function resetDashscopeVideoProviderMocks(mocks: DashscopeVideoProviderMocks): void;
export declare function mockSuccessfulDashscopeVideoTask(mocks: Pick<DashscopeVideoProviderMocks, "postJsonRequestMock" | "fetchWithTimeoutMock">, params?: {
    requestId?: string;
    taskId?: string;
    taskStatus?: string;
    videoUrl?: string;
}): void;
export declare function expectDashscopeVideoTaskPoll(fetchWithTimeoutMock: ChainableResolvedValueMock, params?: {
    baseUrl?: string;
    taskId?: string;
    timeoutMs?: number;
}): void;
export declare function expectSuccessfulDashscopeVideoResult(result: VideoGenerationResult, params?: {
    requestId?: string;
    taskId?: string;
    taskStatus?: string;
}): void;
export {};
