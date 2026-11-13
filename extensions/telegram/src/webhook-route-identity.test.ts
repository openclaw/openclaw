import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import type { Api } from "grammy";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "openclaw/plugin-sdk/webhook-ingress";
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
const legacyListenerForRequest = vi.hoisted(() =>
  vi.fn((): { port: number; host?: string } | undefined => undefined),
);

const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const acceptedResponse = { status: 200, accepted: "durable", body: "" };
const unauthorizedResponse = { status: 401, accepted: null, body: "unauthorized" };
const rateLimitedResponse = { status: 429, accepted: null, body: "Too Many Requests" };

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: () => 0,
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: legacyListenerForRequest,
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

// mock-isolation: stub the grammY bot factory so no real Telegram client or account state is created.
vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

// mock-isolation: stub transport resolution so the suite never opens real undici sockets.
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
  legacyListenerForRequest.mockReset().mockReturnValue(undefined);
  handleUpdateSpy.mockReset().mockImplementation((..._args: unknown[]): unknown => undefined);
  gateway.resetRegistry();
  webhookStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-telegram-webhook-"));
  installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir());
  await openTelegramIngressQueue(requireWebhookQueueScope()).listPending();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  legacyListenerForRequest.mockReset().mockReturnValue(undefined);
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

  it("preserves query-bearing configured identities per account", async () => {
    const seenUpdates: TestTelegramMessageUpdate[] = [];
    handleUpdateSpy.mockImplementation((update: unknown) => {
      seenUpdates.push(update as TestTelegramMessageUpdate);
    });

    await gateway.withWebhook({ secret: TELEGRAM_SECRET, path: "/hook?tenant=a" }, async () => {
      await gateway.withWebhook(
        { secret: TELEGRAM_SECRET, path: "/hook?tenant=b" },
        async ({ port, ingress }) => {
          const postTo = (url: string, update: unknown) =>
            postWebhookJson({ url, payload: JSON.stringify(update), secret: TELEGRAM_SECRET });
          // Each configured query identity keeps its own bucket, so exact
          // deliveries reach their account even though both share a secret.
          for (const [index, path] of ["/hook?tenant=a", "/hook?tenant=b"].entries()) {
            expect(
              await responseResult(
                await postTo(webhookUrl(port, path), telegramMessageUpdate(701 + index, "hi")),
              ),
            ).toEqual(acceptedResponse);
          }
          // Unknown tenants, the bare pathname, and trailing-slash variants
          // never reach either account.
          for (const path of ["/hook?tenant=c", "/hook", "/hook/?tenant=a"]) {
            const rejected = await postTo(
              webhookUrl(port, path),
              telegramMessageUpdate(709, "elsewhere"),
            );
            expect(rejected.status).toBe(404);
          }
          await ingress.waitForIdle();
          expect(seenUpdates.map((update) => update.update_id)).toEqual([701, 702]);
        },
      );
    });
  });

  it("shares the failed-auth budget across query variants of one route", async () => {
    const seenUpdates: TestTelegramMessageUpdate[] = [];
    handleUpdateSpy.mockImplementation((update: unknown) => {
      seenUpdates.push(update as TestTelegramMessageUpdate);
    });

    await gateway.withWebhook(
      { secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH },
      async ({ port, ingress }) => {
        const postWrongSecret = (attempt: number) =>
          postWebhookJson({
            url: `${webhookUrl(port, TELEGRAM_WEBHOOK_PATH)}?attempt=${attempt}`,
            payload: "{}",
            secret: "wrong-secret",
          });
        // Every query variant resolves to the same route identity, so guessing
        // the secret through varying queries drains one shared budget.
        for (let attempt = 1; attempt <= WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; attempt += 1) {
          expect(await responseResult(await postWrongSecret(attempt))).toEqual(
            unauthorizedResponse,
          );
        }
        expect(await responseResult(await postWrongSecret(999))).toEqual(rateLimitedResponse);

        // Authenticated deliveries still pass and are never throttled.
        const base = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
        for (const [index, url] of [base, `${base}?token=known`].entries()) {
          expect(
            await responseResult(
              await postWebhookJson({
                url,
                payload: JSON.stringify(telegramMessageUpdate(801 + index, "hi")),
                secret: TELEGRAM_SECRET,
              }),
            ),
          ).toEqual(acceptedResponse);
        }
        await ingress.waitForIdle();
        expect(seenUpdates.map((update) => update.update_id)).toEqual([801, 802]);
      },
    );
  });

  it("shares the legacy failed-auth budget across query variants of one route", async () => {
    const endpoint = { port: 8787, host: "127.0.0.1" };
    legacyListenerForRequest.mockReturnValue(endpoint);
    try {
      await gateway.withWebhook(
        { secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH, legacyWebhook: endpoint },
        async ({ port }) => {
          const postWrongSecret = (attempt: number) =>
            postWebhookJson({
              url: `${webhookUrl(port, TELEGRAM_WEBHOOK_PATH)}?attempt=${attempt}`,
              payload: "{}",
              secret: "wrong-secret",
            });
          for (let attempt = 1; attempt <= WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests; attempt += 1) {
            expect(await responseResult(await postWrongSecret(attempt))).toEqual(
              unauthorizedResponse,
            );
          }
          expect(await responseResult(await postWrongSecret(999))).toEqual(rateLimitedResponse);
          // The bare route carries the same resolved identity: no fresh budget
          // for the same client without a query string.
          expect(
            await responseResult(
              await postWebhookJson({
                url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
                payload: "{}",
                secret: "wrong-secret",
              }),
            ),
          ).toEqual(rateLimitedResponse);
        },
      );
    } finally {
      legacyListenerForRequest.mockReset().mockReturnValue(undefined);
    }
  });
});
