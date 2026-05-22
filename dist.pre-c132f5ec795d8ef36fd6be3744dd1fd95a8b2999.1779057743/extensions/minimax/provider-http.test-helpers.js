import { afterEach, vi } from "vitest";
//#region extensions/minimax/provider-http.test-helpers.ts
const minimaxProviderHttpMocks = vi.hoisted(() => ({
	resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
	postJsonRequestMock: vi.fn(),
	fetchWithTimeoutMock: vi.fn(),
	fetchProviderOperationResponseMock: vi.fn(),
	fetchProviderDownloadResponseMock: vi.fn(),
	assertOkOrThrowHttpErrorMock: vi.fn(async (_response, _label) => {}),
	resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
		baseUrl: params.baseUrl ?? params.defaultBaseUrl,
		allowPrivateNetwork: false,
		headers: new Headers(params.defaultHeaders),
		dispatcherPolicy: void 0
	}))
}));
function resolveMockProviderTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "function" ? timeoutMs() : timeoutMs ?? 6e4;
}
minimaxProviderHttpMocks.fetchProviderOperationResponseMock.mockImplementation(async (params) => {
	const response = await minimaxProviderHttpMocks.fetchWithTimeoutMock(params.url, params.init ?? {}, resolveMockProviderTimeoutMs(params.timeoutMs), params.fetchFn);
	if (params.requestFailedMessage) await minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
	return response;
});
minimaxProviderHttpMocks.fetchProviderDownloadResponseMock.mockImplementation(async (params) => {
	const response = await minimaxProviderHttpMocks.fetchWithTimeoutMock(params.url, params.init ?? {}, resolveMockProviderTimeoutMs(params.timeoutMs), params.fetchFn);
	await minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
	return response;
});
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({ resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock }));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({
	assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
	createProviderOperationDeadline: ({ label, timeoutMs }) => ({
		label,
		timeoutMs
	}),
	createProviderOperationTimeoutResolver: ({ defaultTimeoutMs }) => () => defaultTimeoutMs,
	fetchProviderDownloadResponse: minimaxProviderHttpMocks.fetchProviderDownloadResponseMock,
	fetchProviderOperationResponse: minimaxProviderHttpMocks.fetchProviderOperationResponseMock,
	fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
	postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
	resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }) => defaultTimeoutMs,
	resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
	waitProviderOperationPollInterval: async () => {}
}));
function getMinimaxProviderHttpMocks() {
	return minimaxProviderHttpMocks;
}
function installMinimaxProviderHttpMockCleanup() {
	afterEach(() => {
		minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
		minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
		minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
		minimaxProviderHttpMocks.fetchProviderOperationResponseMock.mockClear();
		minimaxProviderHttpMocks.fetchProviderDownloadResponseMock.mockClear();
		minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
		minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
	});
}
function loadMinimaxMusicGenerationProviderModule() {
	return import("./music-generation-provider.js");
}
function loadMinimaxVideoGenerationProviderModule() {
	return import("./video-generation-provider.js");
}
//#endregion
export { getMinimaxProviderHttpMocks, installMinimaxProviderHttpMockCleanup, loadMinimaxMusicGenerationProviderModule, loadMinimaxVideoGenerationProviderModule };
