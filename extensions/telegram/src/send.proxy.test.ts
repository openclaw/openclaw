import { Bot } from "grammy";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asTelegramClientFetch } from "./client-fetch.js";
import { TelegramRequestNotStartedError } from "./network-errors.js";
import {
  deleteMessageTelegram,
  reactMessageTelegram,
  resetTelegramClientOptionsCacheForTests,
  sendMessageTelegram,
} from "./send.js";
import * as sendRuntime from "./send.runtime.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import * as targetWriteback from "./target-writeback.js";

describe("Telegram operation leases through real clients", () => {
  const fixture = useTelegramHttpFixture();
  afterEach(() => vi.restoreAllMocks());

  it.each(["media", "mutation"] as const)(
    "keeps a retired transport usable while %s preparation is pending",
    async (kind) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      if (kind === "media") {
        const load = sendRuntime.loadWebMedia;
        vi.spyOn(sendRuntime, "loadWebMedia").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return load(...args);
        });
      } else {
        const persist = targetWriteback.maybePersistResolvedTelegramTarget;
        vi.spyOn(targetWriteback, "maybePersistResolvedTelegramTarget").mockImplementationOnce(
          async (params) => {
            entered.resolve();
            await release.promise;
            return persist(params);
          },
        );
      }
      const sending =
        kind === "media"
          ? sendMessageTelegram("123", "Caption", {
              cfg: fixture.cfg,
              mediaUrl: fixture.photoPath,
              mediaLocalRoots: [fixture.mediaDir],
            })
          : reactMessageTelegram("123", 7, "❤", { cfg: fixture.cfg });
      try {
        await entered.promise;
        resetTelegramClientOptionsCacheForTests();
        expect(fixture.requests).toEqual([]);
        release.resolve();
        await sending;
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          kind === "media" ? "sendPhoto" : "setMessageReaction",
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([sending]);
      }
    },
  );

  it("holds the transport across Telegram's full flood-wait rather than the generic retry cap", async () => {
    const scheduled = createDeferred<number>();
    const release = createDeferred<void>();
    const timer = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 45_000 || delay === 30_000) {
        scheduled.resolve(delay);
        return timer(() => {
          void release.promise.then(() => callback(...args));
        }, 0);
      }
      return timer(callback, delay, ...args);
    });
    fixture.rejections.push({
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 45 },
    });
    const sending = sendMessageTelegram("123", "After flood wait", {
      cfg: fixture.cfg,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 },
    });
    try {
      expect(await scheduled.promise).toBe(45_000);
      expect(fixture.requests).toHaveLength(1);
      resetTelegramClientOptionsCacheForTests();
      release.resolve();
      await expect(sending).resolves.toMatchObject({ messageId: "2" });
      expect(fixture.requests.map(({ fields }) => fields.text)).toEqual([
        "After flood wait",
        "After flood wait",
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([sending]);
    }
  });

  it.each(["not-started", "connect-timeout", "ambiguous"] as const)(
    "preserves %s custody through grammY's transport error envelope",
    async (kind) => {
      let attempts = 0;
      const error =
        kind === "not-started"
          ? new TelegramRequestNotStartedError()
          : kind === "connect-timeout"
            ? Object.assign(new Error("Connect Timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" })
            : new Error("Network request for 'sendMessage' failed after 1 attempts.");
      const bot = new Bot(fixture.cfg.channels.telegram.botToken, {
        client: {
          apiRoot: fixture.cfg.channels.telegram.apiRoot,
          fetch: asTelegramClientFetch(async () => {
            attempts += 1;
            throw error;
          }),
        },
      });
      const sending = sendMessageTelegram("123", "Never accepted", {
        cfg: fixture.cfg,
        api: bot.api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      if (kind === "not-started") {
        await expect(sending).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      } else {
        await expect(sending).rejects.not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      }
      expect(attempts).toBe(kind === "ambiguous" ? 1 : 2);
      expect(fixture.requests).toEqual([]);
    },
  );

  it("bounds a direct delete request with the control-call deadline", async () => {
    const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
    fixture.requestHold = held;
    const timer = global.setTimeout;
    let deadlineObserved = false;
    vi.spyOn(global, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 15_000 && !deadlineObserved) {
        deadlineObserved = true;
        return timer(() => {
          void held.arrived.promise.then(() => callback(...args));
        }, 0);
      }
      return timer(callback, delay, ...args);
    });
    const deleting = deleteMessageTelegram("123", 7, { cfg: fixture.cfg, retry: { attempts: 1 } });
    try {
      await expect(deleting).rejects.toMatchObject({
        error: { message: "Telegram deletemessage timed out after 15000ms" },
      });
      expect(deadlineObserved).toBe(true);
      expect(fixture.requests.map(({ method }) => method)).toEqual(["deleteMessage"]);
    } finally {
      held.release.resolve();
      await Promise.allSettled([deleting]);
    }
  });
});
