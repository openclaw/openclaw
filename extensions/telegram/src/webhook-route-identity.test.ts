import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import type { Api } from "grammy";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";
import {
  telegramMessageUpdate,
  type TestTelegramMessageUpdate,
} from "./test-support/webhook-fixtures.js";
import { createTelegramWebhookTestGateway, webhookUrl } from "./test-support/webhook-gateway.js";
import { postWebhookJson } from "./test-support/webhook-http.js";

const handleUpdateSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const setWebhookSpy = vi.hoisted(() => vi.fn<Api["setWebhook"]>());
const deleteWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
const initSpy = vi.hoisted(() => vi.fn(async () => undefined));
const stopSpy = vi.hoisted(() => vi.fn());
const webhookBotInfo = vi.hoisted(() => ({
  id: 123,
  is_bot: true as const,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  has_topics_enabled: false,
}));
const createWebhookBot = vi.hoisted(() => () => ({
  init: initSpy,
  botInfo: webhookBotInfo,
  handleUpdate: handleUpdateSpy,
  api: {
    setWebhook: setWebhookSpy,
    deleteWebhook: deleteWebhookSpy,
  },
  stop: stopSpy,
}));
const createTelegramBotSpy = vi.hoisted(() => vi.fn(createWebhookBot));
const transportCloseSpies = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
const resolveTelegramTransportSpy = vi.hoisted(() =>
  vi.fn(() => {
    const close = vi.fn(async () => undefined);
    transportCloseSpies.push(close);
    return {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close,
    };
  }),
);

const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const acceptedResponse = { status: 200, accepted: "durable", body: "" };

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: () => 0,
}));

vi.mock("grammy", async () => {
  const actual = await vi.importActual<typeof import("grammy")>("grammy");
  return {
    ...actual,
    API_CONSTANTS: actual.API_CONSTANTS ?? {
      DEFAULT_UPDATE_TYPES: ["message"],
      ALL_UPDATE_TYPES: ["message"],
    },
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: resolveTelegramTransportSpy,
}));

let webhookStateDir: string | undefined;

function requireWebhookQueueScope() {
  if (!webhookStateDir) {
    throw new Error("webhook state dir not initialized");
  }
  return { stateDir: webhookStateDir, accountId: "test" };
}

const gateway = createTelegramWebhookTestGateway({
  token: TELEGRAM_TOKEN,
  queueScope: requireWebhookQueueScope,
});

beforeAll(() => gateway.listen());
afterAll(() => gateway.close());

beforeEach(async () => {
  gateway.resetRegistry();
  webhookStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-telegram-webhook-"));
  installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir());
  await openTelegramIngressQueue(requireWebhookQueueScope()).listPending();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearTelegramRuntime();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const stateDir = webhookStateDir;
  webhookStateDir = undefined;
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

async function responseResult(response: Response) {
  return {
    status: response.status,
    accepted: response.headers.get("x-openclaw-delivery-accepted"),
    body: await response.text(),
  };
}

describe("telegram webhook route identity", () => {
  it("accepts deliveries on the normalized route identity (query params and trailing slash)", async () => {
    const seenUpdates: TestTelegramMessageUpdate[] = [];
    handleUpdateSpy.mockImplementation((update: unknown) => {
      seenUpdates.push(update as TestTelegramMessageUpdate);
    });

    await gateway.withWebhook(
      { secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH },
      async ({ port, ingress }) => {
        const postTo = (url: string, update: unknown) =>
          postWebhookJson({ url, payload: JSON.stringify(update), secret: TELEGRAM_SECRET });
        const base = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
        const variants = [
          `${base}?token=known`,
          `${base}/`,
          `${base}/?token=known`,
          `${base}?token=known&other=1`,
        ];
        for (const [index, url] of variants.entries()) {
          expect(
            await responseResult(await postTo(url, telegramMessageUpdate(601 + index, "hi"))),
          ).toEqual(acceptedResponse);
        }
        const missing = await postTo(
          `${webhookUrl(port, "/other-hook")}?token=known`,
          telegramMessageUpdate(609, "elsewhere"),
        );
        expect(missing.status).toBe(404);
        await ingress.waitForIdle();
        expect(seenUpdates.map((update) => update.update_id)).toEqual([601, 602, 603, 604]);
      },
    );
  });
});
