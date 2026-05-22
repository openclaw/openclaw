import { afterEach, vi } from "vitest";
//#region src/plugin-sdk/test-helpers/provider-http-mocks.ts
const providerHttpMocks = vi.hoisted(() => ({
	resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
	executeProviderOperationWithRetryMock: vi.fn(),
	postJsonRequestMock: vi.fn(),
	postMultipartRequestMock: vi.fn(),
	fetchWithTimeoutMock: vi.fn(),
	fetchWithTimeoutGuardedMock: vi.fn(),
	fetchProviderOperationResponseMock: vi.fn(),
	fetchProviderDownloadResponseMock: vi.fn(),
	pollProviderOperationJsonMock: vi.fn(),
	assertOkOrThrowHttpErrorMock: vi.fn(async (_response, _label) => {}),
	assertOkOrThrowProviderErrorMock: vi.fn(async (_response, _label) => {}),
	sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
	resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
		baseUrl: params.baseUrl ?? params.defaultBaseUrl,
		allowPrivateNetwork: (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
		headers: new Headers(params.defaultHeaders),
		dispatcherPolicy: void 0
	}))
}));
providerHttpMocks.executeProviderOperationWithRetryMock.mockImplementation(async (params) => {
	const attempts = typeof params.retry === "object" ? Math.max(1, Math.round(params.retry.attempts ?? 1)) : params.retry === false || params.stage === "create" ? 1 : 2;
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) try {
		return await params.operation();
	} catch (error) {
		lastError = error;
		if (attempt >= attempts) throw error;
		if (typeof params.retry === "object") await params.retry.sleep?.(0);
	}
	throw lastError;
});
providerHttpMocks.fetchWithTimeoutGuardedMock.mockImplementation(async (...args) => {
	const [url, init, timeoutMs, fetchFn] = args;
	return {
		response: await providerHttpMocks.fetchWithTimeoutMock(url, init ?? {}, timeoutMs ?? 6e4, fetchFn),
		finalUrl: url,
		release: async () => {}
	};
});
providerHttpMocks.postMultipartRequestMock.mockImplementation(async (params) => {
	return {
		response: await providerHttpMocks.fetchWithTimeoutMock(params.url, {
			method: "POST",
			headers: params.headers,
			body: params.body
		}, params.timeoutMs ?? 6e4, params.fetchFn),
		release: async () => {}
	};
});
function resolveMockProviderTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "function" ? timeoutMs() : timeoutMs ?? 6e4;
}
providerHttpMocks.fetchProviderOperationResponseMock.mockImplementation(async (params) => {
	const response = await providerHttpMocks.fetchWithTimeoutMock(params.url, params.init ?? {}, resolveMockProviderTimeoutMs(params.timeoutMs), params.fetchFn);
	if (params.requestFailedMessage) await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
	return response;
});
providerHttpMocks.fetchProviderDownloadResponseMock.mockImplementation(async (params) => {
	const response = await providerHttpMocks.fetchWithTimeoutMock(params.url, params.init ?? {}, resolveMockProviderTimeoutMs(params.timeoutMs), params.fetchFn);
	await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
	return response;
});
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
	createProviderOperationTimeoutResolver: ({ defaultTimeoutMs }) => () => defaultTimeoutMs,
	executeProviderOperationWithRetry: providerHttpMocks.executeProviderOperationWithRetryMock,
	fetchProviderDownloadResponse: providerHttpMocks.fetchProviderDownloadResponseMock,
	fetchProviderOperationResponse: providerHttpMocks.fetchProviderOperationResponseMock,
	fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
	fetchWithTimeoutGuarded: providerHttpMocks.fetchWithTimeoutGuardedMock,
	pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
	postJsonRequest: providerHttpMocks.postJsonRequestMock,
	postMultipartRequest: providerHttpMocks.postMultipartRequestMock,
	providerOperationRetryConfig: (_stage) => true,
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
		providerHttpMocks.executeProviderOperationWithRetryMock.mockClear();
		providerHttpMocks.postJsonRequestMock.mockReset();
		providerHttpMocks.postMultipartRequestMock.mockClear();
		providerHttpMocks.fetchWithTimeoutMock.mockReset();
		providerHttpMocks.fetchWithTimeoutGuardedMock.mockClear();
		providerHttpMocks.fetchProviderOperationResponseMock.mockClear();
		providerHttpMocks.fetchProviderDownloadResponseMock.mockClear();
		providerHttpMocks.pollProviderOperationJsonMock.mockClear();
		providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
		providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
		providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
		providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
	});
}
//#endregion
export { getProviderHttpMocks, installProviderHttpMockCleanup };
