import type {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi, type Mock } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: undefined;
};

type PostJsonRequestMock = Mock<
  (params: Parameters<typeof postJsonRequest>[0]) => Promise<unknown>
>;
type FetchWithTimeoutMock = Mock<
  (
    url: Parameters<typeof fetchWithTimeout>[0],
    init: Parameters<typeof fetchWithTimeout>[1],
    timeoutMs: Parameters<typeof fetchWithTimeout>[2],
    fetchFn?: Parameters<typeof fetchWithTimeout>[3],
  ) => Promise<unknown>
>;

interface MinimaxProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  postJsonRequestMock: PostJsonRequestMock;
  fetchWithTimeoutMock: FetchWithTimeoutMock;
  assertOkOrThrowHttpErrorMock: Mock<typeof assertOkOrThrowHttpError>;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
}

const minimaxProviderHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn<(params: Parameters<typeof postJsonRequest>[0]) => Promise<unknown>>(),
  fetchWithTimeoutMock:
    vi.fn<
      (
        url: Parameters<typeof fetchWithTimeout>[0],
        init: Parameters<typeof fetchWithTimeout>[1],
        timeoutMs: Parameters<typeof fetchWithTimeout>[2],
        fetchFn?: Parameters<typeof fetchWithTimeout>[3],
      ) => Promise<unknown>
    >(),
  assertOkOrThrowHttpErrorMock: vi.fn<typeof assertOkOrThrowHttpError>(
    async (_response: Response, _label: string) => {},
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadline: ({
    label,
    timeoutMs,
  }: {
    label: string;
    timeoutMs?: number;
  }) => ({
    label,
    timeoutMs,
  }),
  fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
  postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getMinimaxProviderHttpMocks(): MinimaxProviderHttpMocks {
  return minimaxProviderHttpMocks;
}

export function installMinimaxProviderHttpMockCleanup(): void {
  afterEach(() => {
    minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
    minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
    minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
    minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
