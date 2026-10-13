import { ServerResponse } from "node:http";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

vi.mock("./webhook-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-spool.js")>()),
  createNextcloudTalkWebhookSpool: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(createNextcloudTalkWebhookSpool).mockReset();
});

const config = {
  channels: {
    "nextcloud-talk": {
      baseUrl: "https://cloud.example.com",
      botSecret: "test-bot-secret",
    },
  },
};

function createMonitorFixture() {
  setNextcloudTalkRuntime(createPluginRuntimeMock());
  const registry = createTestRegistry();
  setActivePluginRegistry(registry);
  const abortController = new AbortController();
  const spool = {
    receive: vi.fn(async () => "accepted" as const),
    ready: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
  };
  vi.mocked(createNextcloudTalkWebhookSpool).mockReturnValue(spool);
  return {
    registry,
    abortController,
    spool,
    options: {
      config,
      runtime: createRuntimeSpies(),
      abortSignal: abortController.signal,
      statusSink: vi.fn(),
    },
  };
}

describe("Nextcloud Talk monitor abort", () => {
  it.each([
    ...["/health", "/healthz", "/ready", "/readyz", "/startup", "/startupz"].map((path) => ({
      path,
      reason: "reserved for Gateway checks",
    })),
    { path: "/api/channels/talk", reason: "requires Gateway authentication" },
    { path: "/%61pi/channels/talk", reason: "requires Gateway authentication" },
  ])(
    "blocks incompatible Gateway path $path without a legacy listener and preserves explicit ingress",
    async ({ path, reason }) => {
      const core = createPluginRuntimeMock();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      vi.mocked(core.logging.getChildLogger).mockReturnValue(logger);
      setNextcloudTalkRuntime(core);
      const registry = createTestRegistry();
      setActivePluginRegistry(registry);
      const statusSink = vi.fn();
      const createSpool = vi.mocked(createNextcloudTalkWebhookSpool).mockImplementation(() => ({
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      }));
      for (const webhookPath of [path, `${path}?tenant=a`]) {
        const options = {
          config: {
            gateway: { port: 19001 },
            channels: {
              "nextcloud-talk": {
                ...config.channels["nextcloud-talk"],
                webhookPath,
              },
            },
          },
          runtime: createRuntimeSpies(),
          statusSink,
        };
        const starting = monitorNextcloudTalkProvider(options);
        await expect(starting).rejects.toThrow(reason);
        await expect(starting).rejects.toThrow(
          /Set webhookPath to "\/nextcloud-talk-webhook".*Gateway port 19001\/nextcloud-talk-webhook/,
        );
        expect(createSpool).not.toHaveBeenCalled();
        expect(registry.httpRoutes).toHaveLength(0);
        expect(statusSink).not.toHaveBeenCalled();
      }
      const monitor = await monitorNextcloudTalkProvider({
        config: {
          gateway: { port: 19001 },
          channels: {
            "nextcloud-talk": {
              ...config.channels["nextcloud-talk"],
              webhookPath: `${path}?tenant=a`,
              legacyWebhook: { port: 8788 },
            },
          },
        },
        runtime: createRuntimeSpies(),
        statusSink,
      });
      try {
        expect(registry.httpRoutes).toHaveLength(1);
        expect(statusSink).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Legacy webhook listener 0.0.0.0:8788 remains available"),
        );
        expect(logger.info).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each([
    {
      label: "Gateway-only default",
      settings: {},
      accountId: "default",
      endpoint: undefined,
    },
    {
      label: "explicit port",
      settings: { legacyWebhook: { port: 9876 } },
      accountId: "default",
      endpoint: { port: 9876, host: "0.0.0.0" },
    },
    {
      label: "disabled listener",
      settings: { legacyWebhook: false as const },
      accountId: "default",
      endpoint: undefined,
    },
    {
      label: "inherited listener",
      settings: { legacyWebhook: { port: 9876, host: "127.0.0.1" }, accounts: { secondary: {} } },
      accountId: "secondary",
      endpoint: { port: 9876, host: "127.0.0.1" },
    },
    {
      label: "inherited opt-out",
      settings: { legacyWebhook: false as const, accounts: { secondary: {} } },
      accountId: "secondary",
      endpoint: undefined,
    },
    {
      label: "account override",
      settings: {
        legacyWebhook: false as const,
        accounts: { secondary: { legacyWebhook: { port: 9877, host: "127.0.0.2" } } },
      },
      accountId: "secondary",
      endpoint: { port: 9877, host: "127.0.0.2" },
    },
  ])(
    "registers $label and unregisters ingress before stopping its spool",
    async ({ settings, accountId, endpoint }) => {
      const { registry, abortController, spool, options } = createMonitorFixture();
      spool.stop.mockImplementation(async () => {
        expect(registry.httpRoutes).toHaveLength(0);
      });
      spool.ready.mockImplementation(async () => {
        expect(registry.httpRoutes).toHaveLength(0);
      });
      const channelConfig = { ...config.channels["nextcloud-talk"], ...settings };
      expect(NextcloudTalkConfigSchema.safeParse(channelConfig).success).toBe(true);
      const monitor = await monitorNextcloudTalkProvider({
        ...options,
        config: { channels: { "nextcloud-talk": channelConfig } },
        accountId,
      });

      try {
        expect(registry.httpRoutes).toHaveLength(1);
        expect(registry.httpRoutes[0]?.legacyListeners).toEqual(
          endpoint
            ? [{ ...endpoint, health: { path: "/healthz", contentType: "text/plain" } }]
            : undefined,
        );
        expect(options.statusSink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lifecycle: "ready" }),
        );
      } finally {
        abortController.abort();
        await monitor.stop();
      }
      expect(spool.stop).toHaveBeenCalledOnce();
    },
  );

  it("does not register ingress or publish ready when aborted during spool startup", async () => {
    const { registry, abortController, spool, options } = createMonitorFixture();
    spool.ready.mockImplementation(async () => abortController.abort());
    await monitorNextcloudTalkProvider(options);

    expect(registry.httpRoutes).toHaveLength(0);
    expect(options.statusSink).not.toHaveBeenCalled();
    expect(spool.stop).toHaveBeenCalledOnce();
  });

  it.each(["finish", "close"] as const)(
    "keeps ingress until an admitted acknowledgement emits %s before stopping the spool",
    async (terminalEvent) => {
      setNextcloudTalkRuntime(createPluginRuntimeMock());
      const registry = createTestRegistry();
      setActivePluginRegistry(registry);
      const admitted = createDeferred<void>();
      const release = createDeferred<void>();
      const abortController = new AbortController();
      const spoolStop = vi.fn(async () => {
        expect(registry.httpRoutes).toHaveLength(0);
      });
      vi.mocked(createNextcloudTalkWebhookSpool).mockReturnValue({
        ready: async () => {},
        receive: async () => {
          admitted.resolve();
          await release.promise;
          return "accepted" as const;
        },
        stop: spoolStop,
        waitForIdle: async () => {},
      });
      const monitor = await monitorNextcloudTalkProvider({
        config: {
          channels: {
            "nextcloud-talk": {
              ...config.channels["nextcloud-talk"],
              botSecret: "nextcloud-secret",
            },
          },
        },
        runtime: createRuntimeSpies(),
        abortSignal: abortController.signal,
      });
      const route = registry.httpRoutes[0]!;
      const { body, headers } = createSignedCreateMessageRequest({
        backend: "https://cloud.example.com",
      });
      const request = () =>
        Object.assign(createMockIncomingRequest([body]), {
          method: "POST",
          url: "/nextcloud-talk-webhook",
          headers,
        });
      const req = request();
      const res = new ServerResponse(req);
      const dispatch = route.handler(req, res);
      try {
        await admitted.promise;
        let stopped = false;
        abortController.abort();
        const stopping = monitor.stop().then(() => {
          stopped = true;
        });
        expect(registry.httpRoutes).toHaveLength(1);
        expect(spoolStop).not.toHaveBeenCalled();
        const later = request();
        const retry = new ServerResponse(later);
        await route.handler(later, retry);
        expect(retry.statusCode).toBe(503);

        expect(res.writableEnded).toBe(false);
        release.resolve();
        await dispatch;
        expect(res.statusCode).toBe(200);
        expect(res.getHeader("x-openclaw-delivery-accepted")).toBe("durable");
        expect(res.writableEnded).toBe(true);
        expect(stopped).toBe(false);
        expect(registry.httpRoutes).toHaveLength(1);
        // Without an attached transport, the test owns the response flush/close event.
        res.emit(terminalEvent);
        await stopping;
        expect(spoolStop).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        res.emit("close");
        await dispatch;
        await monitor.stop();
      }
    },
  );
});
