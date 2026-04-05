import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBlueBubblesServerInfoMock = vi.hoisted(() => vi.fn());
const createFixedWindowRateLimiterMock = vi.hoisted(() => vi.fn(() => ({ clear: vi.fn() })));
const createWebhookInFlightLimiterMock = vi.hoisted(() => vi.fn(() => ({ clear: vi.fn() })));
const registerWebhookTargetWithPluginRouteMock = vi.hoisted(() =>
  vi.fn((params: { target: unknown }) => ({
    unregister: vi.fn(),
    target: params.target,
  })),
);
const createBlueBubblesDebounceRegistryMock = vi.hoisted(() =>
  vi.fn(() => ({ removeDebouncer: vi.fn() })),
);

vi.mock("./probe.js", () => ({
  fetchBlueBubblesServerInfo: fetchBlueBubblesServerInfoMock,
}));

vi.mock("./runtime-api.js", () => ({
  WEBHOOK_RATE_LIMIT_DEFAULTS: {
    windowMs: 60_000,
    maxRequests: 100,
    maxTrackedKeys: 1000,
  },
  createFixedWindowRateLimiter: createFixedWindowRateLimiterMock,
  createWebhookInFlightLimiter: createWebhookInFlightLimiterMock,
  registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  readWebhookBodyOrReject: vi.fn(),
  resolveRequestClientIp: vi.fn(),
  resolveWebhookTargetWithAuthOrRejectSync: vi.fn(),
  withResolvedWebhookRequestPipeline: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getBlueBubblesRuntime: vi.fn(() => ({})),
}));

vi.mock("./monitor-debounce.js", () => ({
  createBlueBubblesDebounceRegistry: createBlueBubblesDebounceRegistryMock,
}));

describe("monitorBlueBubblesProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchBlueBubblesServerInfoMock.mockReset();
    fetchBlueBubblesServerInfoMock.mockResolvedValue(null);
    registerWebhookTargetWithPluginRouteMock.mockClear();
  });

  it("auto-enables private-network server-info fetches for loopback server URLs", async () => {
    const { monitorBlueBubblesProvider } = await import("./monitor.js");
    const controller = new AbortController();
    controller.abort();

    await monitorBlueBubblesProvider({
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "test-password",
        },
        baseUrl: "http://127.0.0.1:1234",
      },
      config: {},
      runtime: {},
      abortSignal: controller.signal,
    });

    expect(fetchBlueBubblesServerInfoMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      accountId: "default",
      timeoutMs: 5000,
      allowPrivateNetwork: true,
    });
  });

  it("respects an explicit private-network opt-out for loopback server URLs", async () => {
    const { monitorBlueBubblesProvider } = await import("./monitor.js");
    const controller = new AbortController();
    controller.abort();

    await monitorBlueBubblesProvider({
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          serverUrl: "http://127.0.0.1:1234",
          password: "test-password",
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
        },
        baseUrl: "http://127.0.0.1:1234",
      },
      config: {},
      runtime: {},
      abortSignal: controller.signal,
    });

    expect(fetchBlueBubblesServerInfoMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234",
      password: "test-password",
      accountId: "default",
      timeoutMs: 5000,
      allowPrivateNetwork: false,
    });
  });
});
