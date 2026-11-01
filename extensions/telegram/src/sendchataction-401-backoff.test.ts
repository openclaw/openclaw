import { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asTelegramClientFetch } from "./client-fetch.js";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: vi.fn((_policy, attempt: number) => attempt * 1000),
  sleepWithAbort: mocks.sleepWithAbort,
}));

type Handler = import("./sendchataction-401-backoff.js").TelegramSendChatActionHandler;
let createHandler: typeof import("./sendchataction-401-backoff.js").createTelegramSendChatActionHandler;

describe("createTelegramSendChatActionHandler", () => {
  let now: number;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());
  const setup = (
    sendChatActionFn: (...args: Parameters<Handler["sendChatAction"]>) => Promise<true>,
  ) => {
    const logger = vi.fn();
    const handler = createHandler({ logger });
    return {
      handler,
      logger,
      send: (chatId = 123, threadId?: number) => {
        const threadParams = threadId === undefined ? undefined : { message_thread_id: threadId };
        return handler.sendChatAction(chatId, "typing", threadParams, async () => {
          const api = new Api("123:backoff", {
            fetch: asTelegramClientFetch(
              async () => new Response(JSON.stringify({ ok: true, result: true })),
            ),
          });
          api.config.use(async (prev, method, payload, signal) => {
            await sendChatActionFn(chatId, "typing", threadParams);
            return prev(method, payload, signal);
          });
          api.config.use(handler.apiTransformer);
          return api.sendChatAction(chatId, "typing", threadParams);
        });
      },
    };
  };
  beforeAll(async () => {
    ({ createTelegramSendChatActionHandler: createHandler } =
      await import("./sendchataction-401-backoff.js"));
  });

  const make401Error = () => new Error("401 Unauthorized");
  const makeNetworkError = () =>
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const makeTelegramError = (
    message: string,
    error_code: number,
    parameters?: { retry_after?: number },
  ) => Object.assign(new Error(message), { error_code, parameters });

  it("coalesces pending actions within topic 1", async () => {
    const pending = createDeferred<true>();
    const fn = vi.fn(() => pending.promise);
    const { send } = setup(fn);

    const first = send(-100, 1);
    await send(-100, 1);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(-100, "typing", { message_thread_id: 1 });

    pending.resolve(true);
    await first;
  });

  it("keeps root-chat actions independent from another topic", async () => {
    const pending = createDeferred<true>();
    const fn = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const { send } = setup(fn);

    const first = send(-100);
    await send(-100, 2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, -100, "typing", undefined);
    expect(fn).toHaveBeenNthCalledWith(2, -100, "typing", { message_thread_id: 2 });
    pending.resolve(true);
    await first;

    now = 4999;
    await send(-100);
    await send(-100, 2);
    expect(fn).toHaveBeenCalledTimes(2);

    now = 5000;
    await send(-100);
    await send(-100, 2);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["network code", makeNetworkError(), false],
    ["network snippet", new Error("socket hang up"), false],
    ["same-chat keepalive", makeTelegramError("Bad Gateway", 502), true],
  ] as const)(
    "cools down %s until its retry/coalescing window expires",
    async (_name, error, sameChat) => {
      const chatId = sameChat ? -100 : 123;
      const cooldown = 4000;
      now = sameChat ? 0 : 10_000;
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(true);
      const { send, logger } = setup(fn);
      await expect(send(chatId, sameChat ? undefined : 1)).rejects.toThrow(error.message);
      expect(logger.mock.calls.at(-1)).toEqual([
        `sendChatAction transient error (1). Cooling down ${cooldown}ms before retry.`,
      ]);
      now += cooldown - 1;
      await expect(send(chatId, sameChat ? undefined : 2)).rejects.toThrow(
        "transient cooldown active",
      );
      expect(fn).toHaveBeenCalledTimes(1);
      now += 1;
      await send(chatId);
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks account cooldown after an authorization backoff wait", async () => {
    const older = createDeferred<true>();
    const backoff = createDeferred<void>();
    const backoffStarted = createDeferred<void>();
    const fn = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockRejectedValueOnce(make401Error())
      .mockResolvedValue(true);
    const { send } = setup(fn);
    const inFlight = send(-100, 1);
    await expect(send(-100, 2)).rejects.toThrow("401");
    mocks.sleepWithAbort.mockImplementationOnce(() => {
      backoffStarted.resolve();
      return backoff.promise;
    });
    const waiting = send(-100, 3);
    await backoffStarted.promise;
    const floodFailure = expect(inFlight).rejects.toThrow("Too Many Requests");
    older.reject(makeTelegramError("Too Many Requests", 429, { retry_after: 20 }));
    await floodFailure;
    const rejection = expect(waiting).rejects.toThrow("transient cooldown active");
    backoff.resolve();
    await rejection;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("resets transient counters on non-transient errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeTelegramError("Bad Gateway", 502))
      .mockRejectedValueOnce(new Error("400 Bad Request"))
      .mockRejectedValueOnce(makeTelegramError("Bad Gateway", 502));
    const { send, logger } = setup(fn);

    await expect(send(123)).rejects.toThrow("Bad Gateway");
    now = 5000;
    await expect(send(123)).rejects.toThrow("400 Bad Request");
    now = 9000;
    await expect(send(123)).rejects.toThrow("Bad Gateway");

    expect(
      logger.mock.calls.filter(([message]) =>
        String(message).startsWith("sendChatAction transient error"),
      ),
    ).toEqual([
      ["sendChatAction transient error (1). Cooling down 4000ms before retry."],
      ["sendChatAction transient error (1). Cooling down 4000ms before retry."],
    ]);
  });

  it("is shared across multiple chatIds (global handler)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const { handler, send } = setup(fn);

    await expect(send(111, 1)).rejects.toThrow("401");
    await expect(send(111, 2)).rejects.toThrow("401");
    for (let attempt = 2; attempt < 10; attempt += 1) {
      now += 4000;
      await expect(send(333)).rejects.toThrow("401");
    }

    expect(handler.isSuspended()).toBe(true);
    await send(444);
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it("treats a structured 429 with retry_after=401 as transient, not as a 401 suspension", async () => {
    const make429WithRetryAfter401 = () =>
      Object.assign(
        new Error("Call to 'sendChatAction' failed! (429: Too Many Requests: retry after 401)"),
        { error_code: 429, parameters: { retry_after: 401 } },
      );

    now = 0;
    const fn = vi.fn().mockRejectedValue(make429WithRetryAfter401());
    const { handler, send, logger } = setup(fn);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(send(123)).rejects.toThrow("429");
      now += 402_000; // Advance past Telegram's 401-second transient cooldown.
    }

    expect(handler.isSuspended()).toBe(false);

    expect(logger.mock.calls.filter(([msg]) => String(msg).includes("CRITICAL"))).toEqual([]);
  });
});
