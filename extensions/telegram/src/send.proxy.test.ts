import { Bot } from "grammy";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { TelegramRequestNotStartedError } from "./network-errors.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import {
  deleteMessageTelegram,
  reactMessageTelegram,
  resetTelegramClientOptionsCacheForTests,
  sendMessageTelegram,
} from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import * as targetWriteback from "./target-writeback.js";

describe("Telegram operation leases through real clients", () => {
  const fixture = useTelegramHttpFixture();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Flood gates are per-token process state; never leak one test's wait into the next.
    resetTelegramAccountThrottlersForTest();
  });

  it.each(["media", "mutation"] as const)(
    "keeps a retired transport usable while %s preparation is pending",
    async (kind) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      if (kind === "media") {
        const load = webMedia.loadWebMedia;
        vi.spyOn(webMedia, "loadWebMedia").mockImplementationOnce(async (...args) => {
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

  it("holds the transport across Telegram's full flood-wait", async () => {
    const scheduled = createDeferred<number>();
    const release = createDeferred<void>();
    const timer = global.setTimeout;
    const realNow = Date.now.bind(Date);
    let skippedMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skippedMs);
    vi.spyOn(global, "setTimeout").mockImplementation((callback, delay, ...args) => {
      // The account limiter sleeps until Telegram's retry_after deadline.
      if (delay !== undefined && delay > 44_000 && delay <= 45_000) {
        scheduled.resolve(delay);
        return timer(() => {
          void release.promise.then(() => {
            skippedMs += delay;
            callback(...args);
          });
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
      expect(await scheduled.promise).toBeGreaterThan(44_000);
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

  it.each([
    { writer: "replaced", expectedSends: 1 },
    { writer: "current", expectedSends: 2 },
  ] as const)(
    "rechecks send authority after a flood wait on a turn-bound client ($writer writer)",
    async ({ writer, expectedSends }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      // A turn-bound client carries only the account limiter, not send-context's authority hook.
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      });
      let writerIsCurrent = true;
      const outcome = sendMessageTelegram("123", "Final after flood", {
        cfg: fixture.cfg,
        api: bot.api,
        assertPlatformSendAuthorized: () => {
          if (!writerIsCurrent) {
            throw new Error("session writer replaced");
          }
        },
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      writerIsCurrent = writer === "current";
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await outcome;

      expect(fixture.requests).toHaveLength(expectedSends);
      if (writer === "replaced") {
        expect(String((settled as { error?: unknown }).error)).toContain("session writer replaced");
      } else {
        expect(settled).toMatchObject({ result: { messageId: expect.any(String) } });
      }
    },
  );

  it.each([
    { writer: "current", topicTwoSends: 1 },
    { writer: "replaced", topicTwoSends: 0 },
  ] as const)(
    "admits a queued group topic send only after the flood wait and for the current writer ($writer)",
    async ({ writer, topicTwoSends }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      // Installed last, so it runs first: marks topic 2 entering the account limiter.
      const topicTwoEntered = createDeferred<void>();
      bot.api.config.use((prev, method, payload, signal) => {
        if ((payload as { message_thread_id?: unknown }).message_thread_id === 2) {
          topicTwoEntered.resolve();
        }
        return prev(method, payload, signal);
      });
      const startedAt = Date.now();
      const held = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      fixture.requestHold = held;
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests: retry after 5",
        parameters: { retry_after: 5 },
      });
      let writerIsCurrent = true;
      const sendTopic = (topic: number, authorized: boolean) =>
        sendMessageTelegram("-1001", `Topic ${topic} final`, {
          cfg: fixture.cfg,
          api: bot.api,
          messageThreadId: topic,
          ...(authorized
            ? {
                assertPlatformSendAuthorized: () => {
                  if (!writerIsCurrent) {
                    throw new Error("group session writer replaced");
                  }
                },
              }
            : {}),
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      const topicOne = sendTopic(1, false);
      await held.arrived.promise;
      // Topic 2 passes the caller check and the gate, then queues behind topic 1.
      const topicTwo = sendTopic(2, true);
      await topicTwoEntered.promise;
      await vi.advanceTimersByTimeAsync(0);
      writerIsCurrent = writer !== "replaced";
      held.release.resolve();
      await vi.advanceTimersByTimeAsync(4_900);
      // Nothing reaches Telegram inside retry_after, including the queued topic.
      expect(fixture.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      const [one, two] = await Promise.all([topicOne, topicTwo]);
      const topicTwoRequests = fixture.requests.filter(
        ({ fields }) => fields.message_thread_id === 2,
      );

      expect(one).toMatchObject({ result: { messageId: expect.any(String) } });
      expect(topicTwoRequests).toHaveLength(topicTwoSends);
      if (writer === "replaced") {
        expect(String((two as { error?: unknown }).error)).toContain(
          "group session writer replaced",
        );
      } else {
        expect(two).toMatchObject({ result: { messageId: expect.any(String) } });
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000);
    },
  );

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
