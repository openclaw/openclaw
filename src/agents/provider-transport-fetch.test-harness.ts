import { afterEach, beforeEach, vi } from "vitest";

type ProviderRequestPolicyConfigMockResult = {
  allowPrivateNetwork: boolean;
  trustConfiguredBaseUrlOrigin?: boolean;
  policy?: {
    endpointClass?: string;
  };
};

const {
  buildProviderRequestDispatcherPolicyMock,
  fetchWithSsrFGuardMock,
  ensureModelProviderLocalServiceMock,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
  managedStreamCleanupRegistrations,
} = vi.hoisted(() => {
  // Mock FinalizationRegistry so stream cleanup registrations are directly assertable.
  const managedStreamCleanupRegistrationsLocal: Array<{
    callback: (held: { finalize: () => Promise<void> }) => void;
    held: { finalize: () => Promise<void> };
    token: object;
  }> = [];

  class MockFinalizationRegistry {
    constructor(private callback: (held: { finalize: () => Promise<void> }) => void) {}

    register(_target: object, held: { finalize: () => Promise<void> }, token?: object) {
      managedStreamCleanupRegistrationsLocal.push({
        callback: this.callback,
        held,
        token: token ?? {},
      });
    }

    unregister(token: object) {
      const index = managedStreamCleanupRegistrationsLocal.findIndex(
        (entry) => entry.token === token,
      );
      if (index >= 0) {
        managedStreamCleanupRegistrationsLocal.splice(index, 1);
      }
    }
  }

  vi.stubGlobal("FinalizationRegistry", MockFinalizationRegistry);

  return {
    buildProviderRequestDispatcherPolicyMock: vi.fn<
      (_request?: unknown) => { mode: "direct" } | undefined
    >(() => undefined),
    fetchWithSsrFGuardMock: vi.fn(),
    ensureModelProviderLocalServiceMock: vi.fn(),
    mergeModelProviderRequestOverridesMock: vi.fn((current, overrides) => ({
      ...current,
      ...overrides,
    })),
    resolveProviderRequestPolicyConfigMock: vi.fn<() => ProviderRequestPolicyConfigMockResult>(
      () => ({
        allowPrivateNetwork: false,
      }),
    ),
    shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
    withTrustedEnvProxyGuardedFetchModeMock: vi.fn((params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    })),
    managedStreamCleanupRegistrations: managedStreamCleanupRegistrationsLocal,
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: withTrustedEnvProxyGuardedFetchModeMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
}));

vi.mock("./provider-local-service.js", () => ({
  ensureModelProviderLocalService: ensureModelProviderLocalServiceMock,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: buildProviderRequestDispatcherPolicyMock,
  getModelProviderRequestRouteFacts: vi.fn(() => undefined),
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfig: resolveProviderRequestPolicyConfigMock,
}));

// Static re-exports can load the transport before Vitest installs these mocks.
const { buildGuardedModelFetch } = await import("./provider-transport-fetch.js");
export {
  buildGuardedModelFetch,
  buildProviderRequestDispatcherPolicyMock,
  ensureModelProviderLocalServiceMock,
  fetchWithSsrFGuardMock,
  managedStreamCleanupRegistrations,
  mergeModelProviderRequestOverridesMock,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
  withTrustedEnvProxyGuardedFetchModeMock,
};

export function installProviderTransportFetchTestHooks() {
  beforeEach(() => {
    managedStreamCleanupRegistrations.length = 0;
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    ensureModelProviderLocalServiceMock.mockReset().mockResolvedValue(undefined);
    buildProviderRequestDispatcherPolicyMock.mockClear().mockReturnValue(undefined);
    mergeModelProviderRequestOverridesMock.mockClear();
    resolveProviderRequestPolicyConfigMock
      .mockClear()
      .mockReturnValue({ allowPrivateNetwork: false });
    shouldUseEnvHttpProxyForUrlMock.mockClear().mockReturnValue(false);
    withTrustedEnvProxyGuardedFetchModeMock.mockClear();
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_URL;
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });
}

export function latestGuardedFetchParams(): Record<string, unknown> {
  // All transport calls should pass through the SSRF-guarded fetch seam.
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const params = calls[calls.length - 1]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("Expected guarded fetch call");
  }
  return params;
}
