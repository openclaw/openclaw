import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorRoamProvider } from "./monitor.js";
import type { CoreConfig } from "./types.js";

const { mockResolveRoamAccount, mockResolveLoggerBackedRuntime } = vi.hoisted(() => ({
  mockResolveRoamAccount: vi.fn(),
  mockResolveLoggerBackedRuntime: vi.fn((_runtime: unknown, logger: unknown) => ({
    log: vi.fn(),
    error: vi.fn(),
    ...(logger as object),
  })),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockRegisterUnregister = vi.fn();
const mockActivityRecord = vi.fn();

vi.mock("openclaw/plugin-sdk/extension-shared", () => ({
  resolveLoggerBackedRuntime: mockResolveLoggerBackedRuntime,
}));

vi.mock("./accounts.js", () => ({
  resolveRoamAccount: mockResolveRoamAccount,
}));

vi.mock("./runtime.js", () => ({
  getRoamRuntime: () => ({
    config: { loadConfig: () => ({}) },
    logging: {
      getChildLogger: (_opts?: unknown) => mockLogger,
    },
    channel: {
      activity: { record: mockActivityRecord },
    },
  }),
}));

vi.mock("./inbound.js", () => ({
  handleRoamInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../runtime-api.js", () => ({
  createWebhookInFlightLimiter: () => ({ acquire: vi.fn(), release: vi.fn() }),
  readJsonWebhookBodyOrReject: vi.fn(),
  registerWebhookTargetWithPluginRoute: () => ({ unregister: mockRegisterUnregister }),
  resolveWebhookPath: (opts: {
    webhookPath?: string;
    webhookUrl?: string;
    defaultPath: string;
  }) => {
    if (opts.webhookPath) {
      return opts.webhookPath;
    }
    if (opts.webhookUrl) {
      try {
        return new URL(opts.webhookUrl).pathname;
      } catch {
        return opts.defaultPath;
      }
    }
    return opts.defaultPath;
  },
  withResolvedWebhookRequestPipeline: vi.fn(),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function defaultAccount(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    accountId: "default",
    enabled: true,
    apiKey: "test-api-key",
    apiKeySource: "config",
    config: {},
    ...overrides,
  };
}

describe("monitorRoamProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRoamAccount.mockReturnValue(defaultAccount());
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it("fetches bot identity from /v1/token.info at startup", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        bot: { id: "bot-uuid", name: "TestBot", imageUrl: "https://img.test/bot.png" },
      }),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    const tokenInfoCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/token.info"),
    );
    expect(tokenInfoCall).toBeDefined();
    expect(tokenInfoCall![1].method).toBe("GET");
    expect(tokenInfoCall![1].headers.Authorization).toBe("Bearer test-api-key");
  });

  it("stores bot identity on account when token.info succeeds", async () => {
    const account = defaultAccount();
    mockResolveRoamAccount.mockReturnValue(account);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ bot: { id: "bot-uuid", name: "TestBot" } }),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(account.botIdentity).toEqual({
      id: "bot-uuid",
      name: "TestBot",
      imageUrl: undefined,
    });
  });

  it("continues without botId when token.info fails", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("continues without botId when token.info returns no bot", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("continues without botId when token.info returns HTTP error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch bot identity"),
    );
  });

  it("subscribes webhooks when webhookUrl is configured", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { webhookUrl: "https://example.com/roam-webhook" } }),
    );
    // token.info → no bot, webhook.subscribe → ok
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/webhook.subscribe"),
    );
    expect(subscribeCall).toBeDefined();
    const body = JSON.parse(subscribeCall![1].body);
    expect(body.url).toBe("https://example.com/roam-webhook");
    expect(body.event).toBe("chat.message");
  });

  it("skips subscription when webhookUrl is not configured", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("/v1/webhook.subscribe"),
    );
    expect(subscribeCall).toBeUndefined();
  });

  it("logs warning when subscription fails", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { webhookUrl: "https://example.com/hook" } }),
    );
    // token.info succeeds, webhook.subscribe fails
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // token.info
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" }); // subscribe

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("webhook subscription failed"),
    );
  });

  it("stop() unregisters webhook target", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("stop() unsubscribes webhooks when webhookUrl is configured", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { webhookUrl: "https://example.com/hook" } }),
    );
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    // Unsubscribe is fire-and-forget; flush microtasks
    await vi.waitFor(() => {
      const unsubscribeCall = mockFetch.mock.calls.find(([url]: string[]) =>
        url.includes("/v1/webhook.unsubscribe"),
      );
      expect(unsubscribeCall).toBeDefined();
    });
  });

  it("respects abortSignal", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const controller = new AbortController();
    await monitorRoamProvider({ abortSignal: controller.signal });

    controller.abort();
    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("calls stop immediately when abortSignal is already aborted", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const controller = new AbortController();
    controller.abort();
    await monitorRoamProvider({ abortSignal: controller.signal });

    expect(mockRegisterUnregister).toHaveBeenCalled();
  });

  it("throws when API key is not configured", async () => {
    mockResolveRoamAccount.mockReturnValue(defaultAccount({ apiKey: "" }));

    await expect(monitorRoamProvider({})).rejects.toThrow("API key not configured");
  });

  it("uses custom apiBaseUrl for token.info", async () => {
    const cfg = {
      channels: { roam: { apiBaseUrl: "https://api.roam.dev" } },
    } as CoreConfig;
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({ config: cfg });
    stop();

    const tokenInfoCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCall).toBeDefined();
    expect(tokenInfoCall![0]).toBe("https://api.roam.dev/v1/token.info");
  });

  it("uses per-account apiBaseUrl over top-level config", async () => {
    const cfg = {
      channels: { roam: { apiBaseUrl: "https://api.toplevel.dev" } },
    } as CoreConfig;
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({ config: { apiBaseUrl: "https://api.account.dev" } }),
    );
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({ config: cfg });
    stop();

    const tokenInfoCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("token.info"),
    );
    expect(tokenInfoCall![0]).toBe("https://api.account.dev/v1/token.info");
  });

  it("uses per-account apiBaseUrl for webhook subscription", async () => {
    mockResolveRoamAccount.mockReturnValue(
      defaultAccount({
        config: {
          webhookUrl: "https://example.com/hook",
          apiBaseUrl: "https://api.account.dev",
        },
      }),
    );
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { stop } = await monitorRoamProvider({});
    stop();

    const subscribeCall = mockFetch.mock.calls.find(([url]: string[]) =>
      url.includes("webhook.subscribe"),
    );
    expect(subscribeCall).toBeDefined();
    expect(subscribeCall![0]).toBe("https://api.account.dev/v1/webhook.subscribe");
  });
});
