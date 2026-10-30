import { getProviderHttpMocks } from "openclaw/plugin-sdk/provider-http-test-mocks";
import { beforeEach, expect } from "vitest";

export {
  getProviderHttpMocks as getMinimaxProviderHttpMocks,
  installProviderHttpMockCleanup as installMinimaxProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";

const minimaxProviderHttpMocks = getProviderHttpMocks();

beforeEach(() => {
  minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock.mockImplementation((params) => {
    const headers = new Headers(omitNullRequestHeaders(params.defaultHeaders));
    for (const [key, value] of Object.entries(params.request?.headers ?? {})) {
      if (value === null) {
        headers.delete(key);
      } else {
        headers.set(key, value);
      }
    }
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork:
        (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
      headers,
      dispatcherPolicy: undefined,
    };
  });
});

export function mockCallArg(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

export function expectMinimaxGuardedFetchCall(index: number, url: string) {
  const call = minimaxProviderHttpMocks.fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected MiniMax guarded fetch call ${index + 1}`);
  }
  const [actualUrl, init, timeoutMs, fetchFn, options] = call;
  expect(actualUrl).toBe(url);
  expect((init as RequestInit | undefined)?.method).toBe("GET");
  expect(Number.isInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(fetchFn).toBe(fetch);
  return {
    init: init as RequestInit,
    options: options as Record<string, unknown> | undefined,
  };
}

export function expectAllowPrivateNetworkPolicy(
  options: Record<string, unknown> | undefined,
): void {
  expect(options).toEqual({
    ssrfPolicy: { allowPrivateNetwork: true },
  });
}

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
