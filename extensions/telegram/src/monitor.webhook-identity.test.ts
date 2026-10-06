import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import * as ingressFactory from "./telegram-ingress-drain-factory.js";
import { telegramMessageUpdate } from "./test-support/webhook-fixtures.js";
import {
  createTelegramWebhookTestGateway,
  getServerPort,
  webhookUrl,
} from "./test-support/webhook-gateway.js";
import { postWebhookJson } from "./test-support/webhook-http.js";
import { writeTelegramUpdateOffset } from "./update-offset-store.js";

const handleUpdate = vi.hoisted(() => vi.fn(async (_update: unknown) => {}));
vi.mock("./bot.js", () => ({
  createTelegramBot: async () => ({
    init: async () => {},
    botInfo: { id: 111111, is_bot: true, first_name: "Fixture" },
    handleUpdate,
    api: { setWebhook: async () => true, answerCallbackQuery: async () => true },
    stop: async () => {},
  }),
}));
vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: () => ({
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: async () => {},
  }),
}));

const gateway = createTelegramWebhookTestGateway({
  token: "111111:fixture-a",
  queueScope: () => ({ stateDir: "unused", accountId: "default" }),
});
beforeAll(() => gateway.listen());
afterAll(() => gateway.close());

describe("webhook account identity", () => {
  it.each([false, true])(
    "delivers overlapping update IDs after bot replacement (polling offset: %s)",
    async (hasPollingOffset) => {
      await withStateDirEnv("telegram-webhook-identity-", async ({ stateDir }) => {
        gateway.resetRegistry();
        handleUpdate.mockClear();
        setTelegramRuntime(
          createPluginRuntimeMock({
            state: {
              openKeyedStore: <T>(
                options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
              ) => createPluginStateKeyedStoreForTests<T>("telegram", options),
              openChannelIngressQueue: <
                TPayload,
                TMetadata = unknown,
                TCompletedMetadata = unknown,
              >(
                options: Parameters<TelegramRuntime["state"]["openChannelIngressQueue"]>[0],
              ) =>
                createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
                  ...options,
                  channelId: "telegram",
                  stateDir,
                }),
            },
          }),
        );
        const createIngress = ingressFactory.createTelegramTransportIngressMonitor;
        const url = webhookUrl(getServerPort(gateway.server), "/identity");
        const deliver = async (token: string, text: string) => {
          const ready = createDeferred<ReturnType<typeof createIngress>>();
          const factory = vi
            .spyOn(ingressFactory, "createTelegramTransportIngressMonitor")
            .mockImplementation((params) => {
              const ingress = createIngress(params);
              ready.resolve(ingress);
              return ingress;
            });
          const abort = new AbortController();
          const provider = monitorTelegramProvider({
            token,
            config: {},
            useWebhook: true,
            legacyWebhook: false,
            webhookUrl: url,
            webhookPath: "/identity",
            webhookSecret: "fixture-secret",
            abortSignal: abort.signal,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          });
          try {
            const ingress = await Promise.race([
              ready.promise,
              provider.then(() => {
                throw new Error("Webhook stopped before startup");
              }),
            ]);
            const response = await postWebhookJson({
              url,
              secret: "fixture-secret",
              payload: JSON.stringify(telegramMessageUpdate(42, text)),
            });
            expect(response.status).toBe(200);
            expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
            await ingress.waitForIdle();
          } finally {
            abort.abort();
            factory.mockRestore();
            await provider;
          }
        };
        try {
          if (hasPollingOffset) {
            await writeTelegramUpdateOffset({ botToken: "111111:fixture-a", updateId: 42 });
          }
          await deliver("111111:fixture-a", "bot A");
          await deliver("111111:fixture-a", "same-bot retry");
          await deliver("111111:fixture-rotated", "same-bot token rotation");
          expect(handleUpdate.mock.calls).toEqual([[telegramMessageUpdate(42, "bot A")]]);

          await deliver("222222:fixture-b", "bot B");
          expect(handleUpdate.mock.calls).toEqual([
            [telegramMessageUpdate(42, "bot A")],
            [telegramMessageUpdate(42, "bot B")],
          ]);
          await deliver("333333:fixture-c", "bot C");
          expect(handleUpdate).toHaveBeenLastCalledWith(telegramMessageUpdate(42, "bot C"));
          expect(handleUpdate).toHaveBeenCalledTimes(3);
        } finally {
          clearTelegramRuntimeForTest();
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
  );
});
