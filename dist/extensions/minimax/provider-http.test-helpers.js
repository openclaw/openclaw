import { afterEach, vi } from "vitest";
//#region extensions/minimax/provider-http.test-helpers.ts
const minimaxProviderHttpMocks = vi.hoisted(() => ({
	resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
	postJsonRequestMock: vi.fn(),
	fetchWithTimeoutMock: vi.fn(),
	assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
	resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
		baseUrl: params.baseUrl ?? params.defaultBaseUrl,
		allowPrivateNetwork: false,
		headers: new Headers(params.defaultHeaders),
		dispatcherPolicy: void 0
	}))
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({ resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock }));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({
	assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
	createProviderOperationDeadline: ({ label, timeoutMs }) => ({
		label,
		timeoutMs
	}),
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
