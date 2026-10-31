import { ServerResponse } from "node:http";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { nextcloudTalkPlugin } from "./channel.js";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkWebhookTarget } from "./types.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

vi.mock("./webhook-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook-spool.js")>()),
  createNextcloudTalkWebhookSpool: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(createNextcloudTalkWebhookSpool).mockReset();
});

const defaults = { baseUrl: "https://cloud.example.com", botSecret: "test-bot-secret" };

type ChannelConfig = NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk"]>;
type Endpoint = NextcloudTalkWebhookTarget["legacyListener"];
type ListenerCase = [string, ChannelConfig, Endpoint, string?];
const override = { port: 9877, host: "127.0.0.2" };

function createMonitorFixture() {
  const core = createPluginRuntimeMock();
  setNextcloudTalkRuntime(core);
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
  const runtime = createRuntimeSpies();
  const statusSink = vi.fn<(patch: ChannelAccountSnapshot) => void>();
  return {
    registry,
    abortController,
    spool,
    statusSink,
    start: (settings: ChannelConfig = {}, accountId?: string, gateway?: { port: number }) => {
      const cfg = { gateway, channels: { "nextcloud-talk": { ...defaults, ...settings } } };
      const startAccount = expectDefined(nextcloudTalkPlugin.gateway?.startAccount, "startAccount");
      const ready = createDeferred<void>();
      const task = startAccount(
        createStartAccountContext({
          cfg,
          account: resolveNextcloudTalkAccount({ cfg, accountId }),
          runtime,
          abortSignal: abortController.signal,
          statusPatchSink: (patch) => {
            statusSink(patch);
            if (patch.lifecycle === "ready") {
              ready.resolve();
            }
          },
        }),
      );
      return {
        task,
        get ready() {
          return Promise.race([ready.promise, task]);
        },
        stop: async () => {
          abortController.abort();
          await task;
        },
      };
    },
  };
}

describe("Nextcloud Talk monitor abort", () => {
  it.each([
    { path: "/healthz", reason: "reserved for Gateway checks" },
    { path: "/api/channels/talk", reason: "requires Gateway authentication" },
    { path: "/%61pi/channels/talk", reason: "requires Gateway authentication" },
  ])(
    "blocks incompatible Gateway path $path without a legacy listener and preserves explicit ingress",
    async ({ path, reason }) => {
      const { registry, spool, statusSink, start } = createMonitorFixture();
      const createSpool = vi.mocked(createNextcloudTalkWebhookSpool);
      for (const webhookPath of [path, `${path}?tenant=a`]) {
        const starting = start({ webhookPath }, undefined, { port: 19001 }).task;
        await expect(starting).rejects.toThrow(reason);
        expect(createSpool).not.toHaveBeenCalled();
        expect(registry.httpRoutes).toHaveLength(0);
        expect(statusSink).not.toHaveBeenCalled();
      }
      const monitor = start(
        { webhookPath: `${path}?tenant=a`, legacyWebhook: { port: 8788 } },
        undefined,
        { port: 19001 },
      );
      await monitor.ready;
      try {
        expect(registry.httpRoutes).toHaveLength(1);
        expect(statusSink).toHaveBeenCalledOnce();
      } finally {
        await monitor.stop();
      }
      expect(spool.stop).toHaveBeenCalledOnce();
    },
  );

  it.each<ListenerCase>([
    ["Gateway-only", {}, undefined],
    ["explicit port", { legacyWebhook: { port: 9876 } }, { port: 9876, host: "0.0.0.0" }],
    [
      "account override",
      { legacyWebhook: false, accounts: { secondary: { legacyWebhook: override } } },
      override,
      "secondary",
    ],
  ])(
    "registers %s and unregisters ingress before stopping its spool",
    async (_label, settings, endpoint, accountId) => {
      const { registry, spool, statusSink, start } = createMonitorFixture();
      const expectUnregistered = async () => {
        expect(registry.httpRoutes).toHaveLength(0);
      };
      spool.stop.mockImplementation(expectUnregistered);
      spool.ready.mockImplementation(expectUnregistered);
      const monitor = start(settings, accountId);
      await monitor.ready;

      try {
        expect(registry.httpRoutes).toHaveLength(1);
        expect(registry.httpRoutes[0]?.legacyListeners).toEqual(
          endpoint
            ? [{ ...endpoint, health: { path: "/healthz", contentType: "text/plain" } }]
            : undefined,
        );
        expect(statusSink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ lifecycle: "ready" }),
        );
      } finally {
        await monitor.stop();
      }
      expect(spool.stop).toHaveBeenCalledOnce();
    },
  );
  it("does not register ingress or publish ready when aborted during spool startup", async () => {
    const { registry, abortController, spool, statusSink, start } = createMonitorFixture();
    spool.ready.mockImplementation(async () => abortController.abort());
    await start().task;

    expect(registry.httpRoutes).toHaveLength(0);
    expect(statusSink).not.toHaveBeenCalled();
    expect(spool.stop).toHaveBeenCalledOnce();
  });

  it.each(["finish", "close"] as const)(
    "keeps ingress until an admitted acknowledgement emits %s before stopping the spool",
    async (terminalEvent) => {
      const { registry, abortController, spool, start } = createMonitorFixture();
      const admitted = createDeferred<void>();
      const release = createDeferred<void>();
      const spoolStop = spool.stop.mockImplementation(async () => {
        expect(registry.httpRoutes).toHaveLength(0);
      });
      spool.receive.mockImplementation(async () => {
        admitted.resolve();
        await release.promise;
        return "accepted" as const;
      });
      const monitor = start({ botSecret: "nextcloud-secret" });
      await monitor.ready;
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
        expect(res).toMatchObject({ statusCode: 200, writableEnded: true });
        expect(res.getHeader("x-openclaw-delivery-accepted")).toBe("durable");
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
