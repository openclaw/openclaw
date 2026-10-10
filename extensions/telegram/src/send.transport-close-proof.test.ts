import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Bot } from "grammy";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler, runReplaceableTelegramRequest } from "./account-throttler.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { TelegramRequestNotStartedError } from "./network-errors.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import {
  deleteMessageTelegram,
  editMessageTelegram,
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

  it.each(["current", "retired"] as const)(
    "queued unfinished preview retains network authority (%s writer)",
    async (writer) => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
      const token = fixture.cfg.channels.telegram.botToken;
      const bot = new Bot(token, { client: { apiRoot: fixture.cfg.channels.telegram.apiRoot } });
      bot.api.config.use(getOrCreateAccountThrottler(token).transformer);
      const entered = createDeferred<void>();
      bot.api.config.use((prev, method, payload, signal) => {
        if (method === "editMessageText") {
          entered.resolve();
        }
        return prev(method, payload, signal);
      });
      let current = true;
      const stream = createTelegramDraftStream({
        api: bot.api,
        chatId: -1001,
        thread: { id: 2, scope: "forum" },
      });
      const authority = () => {
        if (!current) {
          throw new Error("preview writer retired");
        }
      };
      stream.update("seed preview", { assertPlatformSendAuthorized: authority });
      await stream.flush();
      const hold = { arrived: createDeferred<void>(), release: createDeferred<void>() };
      fixture.requestHold = hold;
      // A replaceable blocker lets the preview queue without yielding to a final reply.
      const blocker = runReplaceableTelegramRequest(() =>
        bot.api.sendMessage(-1001, "queue blocker", { message_thread_id: 1 }),
      );
      try {
        await hold.arrived.promise;
        stream.update("queued preview", { assertPlatformSendAuthorized: authority });
        const flushed = stream.flush();
        await entered.promise;
        current = writer === "current";
        hold.release.resolve();
        await blocker;
        await flushed;
        expect(
          fixture.requests
            .filter(({ method }) => method === "editMessageText")
            .map(({ fields }) => fields.text),
        ).toEqual(writer === "current" ? ["queued preview"] : []);
      } finally {
        hold.release.resolve();
        await Promise.allSettled([blocker, stream.discard()]);
      }
    },
  );

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

describe("telegram transport cache eviction over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  const liveSockets = new Set<Socket>();
  const requestSockets = new Map<string, Socket>();
  let sendMessageCalls = 0;
  let slowResponse: ReturnType<typeof createDeferred<() => void>> | undefined;

  beforeEach(() => {
    // This fixture owns its loopback sockets, not the operator's proxy route.
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
      "OPENCLAW_PROXY_URL",
      "OPENCLAW_PROXY_ACTIVE",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
    ]) {
      vi.stubEnv(key, undefined);
    }
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on("end", () => {
        const url = req.url ?? "";
        const respond = (result: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (url.includes("/sendMessage") || url.includes("/editMessageText")) {
          requestSockets.set(url.slice(0, url.lastIndexOf("/")), req.socket);
          sendMessageCalls += 1;
          if (slowResponse) {
            slowResponse.resolve(() => {
              respond({ message_id: sendMessageCalls, chat: { id: 123 } });
            });
            return;
          }
          respond({ message_id: sendMessageCalls, chat: { id: 123 } });
          return;
        }
        if (url.includes("/getChat")) {
          respond({ id: 123, type: "private" });
          return;
        }
        respond(true);
      });
      req.resume();
    });
    // Omit the peer idle deadline so the unchanged client 30s idle policy cannot
    // satisfy the 3s eviction checks. Idle peer closure is injected explicitly below.
    server.keepAliveTimeout = 0;
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.on("close", () => liveSockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetTelegramClientOptionsCacheForTests();
    vi.unstubAllEnvs();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("closes retired transports only after their active sends finish", async () => {
    resetTelegramClientOptionsCacheForTests();

    const ACCOUNTS = 70;
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: ACCOUNTS }, (_, i) => [
              `acct-${i}`,
              { botToken: `10${i}:e2e-token-${i}`, apiRoot },
            ]),
          ),
        },
      },
    };
    const socketForAccount = (account: number) => {
      const socket = requestSockets.get(`/bot10${account}:e2e-token-${account}`);
      if (!socket) {
        throw new Error(`Telegram socket for acct-${account} was not captured`);
      }
      return socket;
    };
    // Edits retain idle pooling; new messages deliberately do not. Exercise both
    // through the same cached account transport and its active-operation lease.
    const send = async (account: number, text: string, create = false) => {
      const opts = { cfg, accountId: `acct-${account}` };
      const result = create
        ? await sendMessageTelegram("123", text, opts)
        : await editMessageTelegram("123", 1, text, opts);
      expect(result.messageId).toBeTruthy();
      return socketForAccount(account);
    };

    // Fill the cache to its 64-entry cap, then let the peer retire an idle socket.
    for (let i = 0; i < 64; i += 1) {
      await send(i, `hello ${i}`);
    }
    expect(requestSockets.size).toBe(64);
    const peerSocket = await send(0, "refresh before peer close");
    const peerClosed = new Promise<void>((resolve) => {
      peerSocket.once("close", resolve);
    });
    peerSocket.end();
    await peerClosed;
    expect(liveSockets.has(peerSocket)).toBe(false);

    // Put acct-0 (the oldest cache entry) mid-flight on its replacement socket.
    const inFlight = createDeferred<() => void>();
    slowResponse = inFlight;
    const slowSend = send(0, "slow", true);
    const releaseResponse = await inFlight.promise;
    slowResponse = undefined;
    const activeSocket = socketForAccount(0);

    try {
      expect(activeSocket).not.toBe(peerSocket);
      // New cache key retires acct-0, but its exact socket must survive the lease.
      await send(64, "evictor");
      expect(liveSockets.has(activeSocket)).toBe(true);
    } finally {
      releaseResponse();
      await slowSend.catch(() => undefined);
    }
    expect(await slowSend).toBe(activeSocket);
    await vi.waitFor(() => expect(liveSockets.has(activeSocket)).toBe(false), { timeout: 3000 });

    // Refresh each idle entry before eviction so an earlier peer close cannot
    // stand in for closing the transport's current socket.
    for (let i = 65; i < ACCOUNTS; i += 1) {
      const idleSocket = await send(i - 64, "refresh before eviction");
      expect(liveSockets.has(idleSocket)).toBe(true);
      await send(i, `hello ${i}`);
      await vi.waitFor(() => expect(liveSockets.has(idleSocket)).toBe(false), { timeout: 3000 });
    }

    // Retained transports still deliver after an unrelated idle peer close.
    await send(6, "retained");
    expect(sendMessageCalls).toBe(ACCOUNTS + 8);
    expect(requestSockets.size).toBe(ACCOUNTS);

    const idleBeforeReset = await send(7, "idle before reset");
    const resetInFlight = createDeferred<() => void>();
    slowResponse = resetInFlight;
    const resetSend = send(6, "active during reset", true);
    const releaseResetResponse = await resetInFlight.promise;
    slowResponse = undefined;
    const activeBeforeReset = socketForAccount(6);
    try {
      resetTelegramClientOptionsCacheForTests();
      expect(liveSockets.has(activeBeforeReset)).toBe(true);
      await vi.waitFor(() => expect(liveSockets.has(idleBeforeReset)).toBe(false), {
        timeout: 3000,
      });
    } finally {
      releaseResetResponse();
      await resetSend.catch(() => undefined);
    }
    expect(await resetSend).toBe(activeBeforeReset);
    await vi.waitFor(() => expect(liveSockets.has(activeBeforeReset)).toBe(false), {
      timeout: 3000,
    });
    expect(await send(6, "fresh after reset")).not.toBe(activeBeforeReset);
  });
});
