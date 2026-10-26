import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { monitorTelegramProvider } from "./monitor.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
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
afterEach(clearTelegramRuntimeForTest);

it("isolates webhook update IDs from polling offsets and other bots", () =>
  withOpenClawTestState(
    { prefix: "telegram-webhook-identity-", layout: "state-only" },
    async () => {
      gateway.resetRegistry();
      handleUpdate.mockClear();
      await withRegisteredChannelIngress(
        { plugin: telegramPlugin, config: {}, setRuntime: setTelegramRuntime },
        async () => {
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
              await ingress.waitForIdle();
            } finally {
              abort.abort();
              factory.mockRestore();
              await provider;
            }
          };
          await writeTelegramUpdateOffset({ botToken: "111111:fixture-a", updateId: 42 });
          await deliver("111111:fixture-a", "bot A");
          await deliver("111111:fixture-a", "same-bot retry");
          await deliver("111111:fixture-rotated", "same-bot token rotation");

          await deliver("222222:fixture-b", "bot B");
          expect(handleUpdate.mock.calls).toEqual(
            ["bot A", "bot B"].map((text) => [telegramMessageUpdate(42, text)]),
          );
        },
      );
    },
  ));
