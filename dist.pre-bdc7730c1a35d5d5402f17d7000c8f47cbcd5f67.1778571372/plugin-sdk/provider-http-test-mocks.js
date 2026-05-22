import { afterEach, vi } from "vitest";
//#region src/plugin-sdk/test-helpers/provider-http-mocks.ts
const providerHttpMocks = vi.hoisted(() => ({
	resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
	postJsonRequestMock: vi.fn(),
	fetchWithTimeoutMock: vi.fn(),
	pollProviderOperationJsonMock: vi.fn(),
	assertOkOrThrowHttpErrorMock: vi.fn(async (_response, _label) => {}),
	assertOkOrThrowProviderErrorMock: vi.fn(async (_response, _label) => {}),
	sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
	resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
		baseUrl: params.baseUrl ?? params.defaultBaseUrl,
		allowPrivateNetwork: params.allowPrivateNetwork === true,
		headers: new Headers(params.defaultHeaders),
		dispatcherPolicy: void 0
	}))
}));
providerHttpMocks.pollProviderOperationJsonMock.mockImplementation(async (params) => {
	for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
		const response = await providerHttpMocks.fetchWithTimeoutMock(params.url, {
			method: "GET",
			headers: params.headers
		}, params.defaultTimeoutMs, params.fetchFn);
		await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
		const payload = await response.json();
		if (params.isComplete(payload)) return payload;
		const failureMessage = params.getFailureMessage?.(payload);
		if (failureMessage) throw new Error(failureMessage);
	}
	throw new Error(params.timeoutMessage);
});
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({ resolveApiKeyForProvider: providerHttpMocks.resolveApiKeyForProviderMock }));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({
	assertOkOrThrowHttpError: providerHttpMocks.assertOkOrThrowHttpErrorMock,
	assertOkOrThrowProviderError: providerHttpMocks.assertOkOrThrowProviderErrorMock,
	createProviderOperationDeadline: ({ label, timeoutMs }) => ({
		label,
		timeoutMs
	}),
	fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
	pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
	postJsonRequest: providerHttpMocks.postJsonRequestMock,
	resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }) => defaultTimeoutMs,
	resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
	sanitizeConfiguredModelProviderRequest: providerHttpMocks.sanitizeConfiguredModelProviderRequestMock,
	waitProviderOperationPollInterval: async () => {}
}));
function getProviderHttpMocks() {
	return providerHttpMocks;
}
function installProviderHttpMockCleanup() {
	afterEach(() => {
		providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
		providerHttpMocks.postJsonRequestMock.mockReset();
		providerHttpMocks.fetchWithTimeoutMock.mockReset();
		providerHttpMocks.pollProviderOperationJsonMock.mockClear();
		providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
		providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
		providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
		providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
	});
}
//#endregion
export { getProviderHttpMocks, installProviderHttpMockCleanup };
