// Telegram tests cover account throttler plugin behavior.
import { createRequire } from "node:module";
import { Api } from "grammy";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler, runReplaceableTelegramRequest } from "./account-throttler.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";

type TelegramTransform = ReturnType<typeof getOrCreateAccountThrottler>["transformer"];
type TelegramPreviousCall = Parameters<TelegramTransform>[0];

const {
  AbortController: TelegramAbortController,
}: {
  AbortController: new () => {
    signal: NonNullable<Parameters<Api["sendChatAction"]>[3]>;
    abort: () => void;
  };
} = createRequire(import.meta.resolve("grammy"))("abort-controller");

function callLooseSendMessage(
  throttler: TelegramTransform,
  prev: TelegramPreviousCall,
  payload: Record<string, unknown>,
) {
  const loose = throttler as (
    prev: TelegramPreviousCall,
    method: "sendMessage",
    payload: unknown,
    signal: undefined,
  ) => ReturnType<TelegramTransform>;
  return loose(prev, "sendMessage", payload, undefined);
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve: resolve! };
}

describe("getOrCreateAccountThrottler", () => {
  beforeEach(() => {
    resetTelegramAccountThrottlersForTest();
  });

  it("shares throttlers per bot token", () => {
    const first = getOrCreateAccountThrottler("tok");
    const second = getOrCreateAccountThrottler("tok");
    const other = getOrCreateAccountThrottler("other");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("preserves the group message budget while sending topic actions", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const api = new Api("123:typing-budget", {
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: asTelegramClientFetch(async (input: unknown) => {
        assert(typeof input === "string");
        const url = input;
        const method = url.slice(url.lastIndexOf("/") + 1);
        sent.push(method);
        return new Response(
          JSON.stringify({
            ok: true,
            result:
              method === "sendChatAction"
                ? true
                : {
                    message_id: sent.length,
                    date: 0,
                    chat: { id: -100123, type: "supergroup", title: "Topics" },
                    text: "Complete",
                  },
          }),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("typing-budget").transformer);
    const actions = Array.from({ length: 21 }, (_, index) =>
      api.sendChatAction(-100123, "typing", { message_thread_id: index + 1 }),
    );
    const replies = Array.from({ length: 21 }, () => api.sendMessage(-100123, "Complete"));
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(21);
      expect(sent.filter((method) => method === "sendMessage")).toHaveLength(20);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(sent.filter((method) => method === "sendMessage")).toHaveLength(21);
    } finally {
      await vi.advanceTimersByTimeAsync(180_000);
      await Promise.all([...actions, ...replies]);
      vi.useRealTimers();
    }
  });

  it("shares suspension and recovery across clients for the same token", async () => {
    vi.useFakeTimers();
    let sent = 0;
    const fetch = asTelegramClientFetch(async () => {
      sent++;
      return new Response(
        JSON.stringify(
          sent <= 10
            ? { ok: false, error_code: 401, description: "Unauthorized" }
            : { ok: true, result: true },
        ),
      );
    });
    const first = new Api("123:shared-failures", { fetch });
    const second = new Api("123:shared-failures", { fetch });
    const account = getOrCreateAccountThrottler("shared-failures");
    first.config.use(account.transformer);
    second.config.use(getOrCreateAccountThrottler("shared-failures").transformer);
    const attempts = Array.from({ length: 11 }, (_, index) =>
      (index % 2 === 0 ? first : second).sendChatAction(-100123, "typing", {
        message_thread_id: index + 1,
      }),
    );
    const results = Promise.allSettled(attempts);
    try {
      await vi.advanceTimersByTimeAsync(600_000);
      expect((await results).every((result) => result.status === "rejected")).toBe(true);
      expect(sent).toBe(10);
      expect(account.chatActions.isSuspended()).toBe(true);
      account.chatActions.reset();
      const recovered = second.sendChatAction(-100123, "typing", { message_thread_id: 12 });
      await vi.advanceTimersByTimeAsync(1_000);
      await recovered;
      expect(sent).toBe(11);
    } finally {
      await vi.advanceTimersByTimeAsync(600_000);
      await results;
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "flood wait", errorCode: 429, secondStatus: "rejected" },
    {
      name: "authorization backoff",
      errorCode: 401,
      secondStatus: "fulfilled",
    },
  ])("rechecks $name before sending a queued topic action", async ({ errorCode, secondStatus }) => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const startedAt = Date.now();
    const api = new Api("123:queued-failure", {
      fetch: asTelegramClientFetch(async () => {
        sent.push(Date.now() - startedAt);
        return new Response(
          JSON.stringify(
            sent.length === 1
              ? {
                  ok: false,
                  error_code: errorCode,
                  description: errorCode === 429 ? "Too Many Requests" : "Unauthorized",
                  ...(errorCode === 429 ? { parameters: { retry_after: 20 } } : {}),
                }
              : { ok: true, result: true },
          ),
        );
      }),
    });
    const account = getOrCreateAccountThrottler("queued-failure");
    api.config.use(account.transformer);
    const first = api.sendChatAction(-100123, "typing", { message_thread_id: 10 });
    const second = api.sendChatAction(-100123, "typing", { message_thread_id: 20 });
    const results = Promise.allSettled([first, second]);
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await results).map((result) => result.status)).toEqual(["rejected", secondStatus]);
      if (secondStatus === "fulfilled") {
        expect(sent[1]).toBeGreaterThanOrEqual(1_900);
        const nextTopic = api.sendChatAction(-100123, "typing", { message_thread_id: 40 });
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1_000);
        await nextTopic;
        const [, previousAt, nextAt] = sent;
        assert(previousAt !== undefined && nextAt !== undefined);
        expect(nextAt - previousAt).toBeGreaterThanOrEqual(1_000);
      }
      await vi.advanceTimersByTimeAsync(20_000);
      account.chatActions.reset();
      const recovered = api.sendChatAction(-100123, "typing", { message_thread_id: 30 });
      await vi.advanceTimersByTimeAsync(1_000);
      await recovered;
      expect(sent).toHaveLength(secondStatus === "fulfilled" ? 4 : 2);
    } finally {
      await vi.advanceTimersByTimeAsync(25_000);
      await results;
      vi.useRealTimers();
    }
  });

  it("releases a topic action canceled during authorization backoff", async () => {
    vi.useFakeTimers();
    let sent = 0;
    const api = new Api("123:canceled-backoff", {
      fetch: asTelegramClientFetch(async () => {
        sent++;
        return new Response(
          JSON.stringify(
            sent === 1
              ? { ok: false, error_code: 401, description: "Unauthorized" }
              : { ok: true, result: true },
          ),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("canceled-backoff").transformer);
    const first = api.sendChatAction(-100123, "typing", { message_thread_id: 1 });
    const failed = expect(first).rejects.toThrow("Unauthorized");
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    const controller = new TelegramAbortController();
    const canceled = api.sendChatAction(
      -100123,
      "typing",
      { message_thread_id: 2 },
      controller.signal,
    );
    const settled = vi.fn();
    const outcome = canceled.then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledOnce();
      expect(sent).toBe(1);
      const recovered = api.sendChatAction(-100123, "typing", { message_thread_id: 3 });
      await vi.advanceTimersByTimeAsync(3_000);
      await recovered;
      expect(sent).toBe(2);
    } finally {
      await vi.advanceTimersByTimeAsync(10_000);
      await outcome;
      vi.useRealTimers();
    }
  });

  it.each(["group queue", "authorization queue"])(
    "settles cancellation in the %s without releasing an active predecessor",
    async (queue) => {
      vi.useFakeTimers();
      const authorization = queue === "authorization queue";
      const held = deferred<Response>();
      let sent = 0;
      const api = new Api("123:queued-wait", {
        fetch: asTelegramClientFetch(async () => {
          sent++;
          if (authorization && sent === 1) {
            return new Response(
              JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
            );
          }
          if (sent === (authorization ? 2 : 1)) {
            return held.promise;
          }
          return new Response(JSON.stringify({ ok: true, result: true }));
        }),
      });
      api.config.use(getOrCreateAccountThrottler("queued-wait").transformer);
      if (authorization) {
        const failed = expect(api.sendChatAction(-100123, "typing")).rejects.toThrow(
          "Unauthorized",
        );
        await vi.advanceTimersByTimeAsync(0);
        await failed;
      }
      const predecessor = api.sendChatAction(-100123, "typing", { message_thread_id: 1 });
      await vi.advanceTimersByTimeAsync(authorization ? 2_200 : 0);
      const controller = new TelegramAbortController();
      const canceled = api.sendChatAction(
        authorization ? -100456 : -100123,
        "typing",
        { message_thread_id: 2 },
        controller.signal,
      );
      const settled = vi.fn();
      const outcome = canceled.then(settled, settled);
      const successor = api.sendChatAction(authorization ? -100789 : -100123, "typing", {
        message_thread_id: 3,
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toHaveBeenCalledOnce();
        expect(sent).toBe(authorization ? 2 : 1);
        held.resolve(new Response(JSON.stringify({ ok: true, result: true })));
        await vi.advanceTimersByTimeAsync(2_000);
        await Promise.all([predecessor, successor]);
        expect(sent).toBe(authorization ? 3 : 2);
      } finally {
        held.resolve(new Response(JSON.stringify({ ok: true, result: true })));
        await vi.advanceTimersByTimeAsync(10_000);
        await Promise.all([predecessor, outcome, successor]);
        vi.useRealTimers();
      }
    },
  );

  it("does not spend action spacing on canceled requests", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const api = new Api("123:canceled-actions", {
      fetch: asTelegramClientFetch(async () => {
        sent.push(Date.now());
        return new Response(JSON.stringify({ ok: true, result: true }));
      }),
    });
    api.config.use((prev, method, payload, signal) => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return prev(method, payload, signal);
    });
    api.config.use(getOrCreateAccountThrottler("canceled-actions").transformer);
    const first = api.sendChatAction(-100123, "typing", { message_thread_id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const controllers = Array.from({ length: 5 }, () => new TelegramAbortController());
    const canceled = controllers.map((controller, index) =>
      api.sendChatAction(-100123, "typing", { message_thread_id: index + 2 }, controller.signal),
    );
    const results = Promise.allSettled(canceled);
    const next = api.sendChatAction(-100123, "typing", { message_thread_id: 10 });
    try {
      await vi.advanceTimersByTimeAsync(100);
      controllers.forEach((controller) => controller.abort());
      await vi.advanceTimersByTimeAsync(900);
      expect(sent).toHaveLength(2);
      const [firstAt, nextAt] = sent;
      assert(firstAt !== undefined && nextAt !== undefined);
      expect(nextAt - firstAt).toBe(1_000);
      expect((await results).every((result) => result.status === "rejected")).toBe(true);
      await next;
    } finally {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([results, next]);
      vi.useRealTimers();
    }
  });

  it("holds every chat on the token for a flood wait and skips previews until it clears", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const sent: Array<{ chatId: number; text: string; at: number }> = [];
    const api = new Api("123:flood-gate", {
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: asTelegramClientFetch(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
        sent.push({ chatId: body.chat_id, text: body.text, at: Date.now() - startedAt });
        return new Response(
          JSON.stringify(
            sent.length === 1
              ? {
                  ok: false,
                  error_code: 429,
                  description: "Too Many Requests: retry after 7",
                  parameters: { retry_after: 7 },
                }
              : {
                  ok: true,
                  result: {
                    message_id: sent.length,
                    date: 0,
                    chat: { id: body.chat_id, type: "supergroup", title: "Topics" },
                    text: body.text,
                  },
                },
          ),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("flood-gate").transformer);
    const final = api.sendMessage(-100111, "final answer", { message_thread_id: 5 });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.map(({ text }) => text)).toEqual(["final answer"]);

    const otherChat = api.sendMessage(-100222, "other chat reply");
    const preview = runReplaceableTelegramRequest(() =>
      api.editMessageText(-100222, 9, "preview while flooded"),
    );
    await expect(preview).rejects.toMatchObject({ error_code: 429 });
    try {
      await vi.advanceTimersByTimeAsync(6_800);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(final).resolves.toMatchObject({ text: "final answer" });
      await expect(otherChat).resolves.toMatchObject({ text: "other chat reply" });
      expect(sent.map(({ text }) => text)).toEqual([
        "final answer",
        "final answer",
        "other chat reply",
      ]);
      expect(sent.slice(1).every(({ at }) => at >= 7_000)).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.allSettled([final, otherChat]);
      vi.useRealTimers();
    }
  });

  it("lets a typing flood wait hold replies in another chat on the same token", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const sent: Array<{ method: string; at: number }> = [];
    const api = new Api("123:typing-flood", {
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: asTelegramClientFetch(async (input: unknown, init?: { body?: unknown }) => {
        assert(typeof input === "string");
        const method = input.slice(input.lastIndexOf("/") + 1);
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text?: string };
        sent.push({ method, at: Date.now() - startedAt });
        return new Response(
          JSON.stringify(
            method === "sendChatAction"
              ? {
                  ok: false,
                  error_code: 429,
                  description: "Too Many Requests: retry after 6",
                  parameters: { retry_after: 6 },
                }
              : {
                  ok: true,
                  result: {
                    message_id: sent.length,
                    date: 0,
                    chat: { id: body.chat_id, type: "supergroup", title: "Topics" },
                    text: body.text,
                  },
                },
          ),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("typing-flood").transformer);
    try {
      await expect(api.sendChatAction(-100111, "typing")).rejects.toMatchObject({
        error_code: 429,
      });
      const reply = api.sendMessage(-100222, "final answer");
      await vi.advanceTimersByTimeAsync(5_500);
      expect(sent.map(({ method }) => method)).toEqual(["sendChatAction"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reply).resolves.toMatchObject({ text: "final answer" });
      expect(sent[1]).toMatchObject({ method: "sendMessage" });
      expect(sent[1]!.at).toBeGreaterThanOrEqual(6_000);
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
    }
  });

  it("pauses a fixed second for a 429 without retry_after and yields previews to the reply", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const sent: number[] = [];
    const api = new Api("123:flood-bare", {
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: asTelegramClientFetch(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
        sent.push(Date.now() - startedAt);
        return new Response(
          JSON.stringify(
            sent.length <= 2
              ? { ok: false, error_code: 429, description: "Too Many Requests" }
              : {
                  ok: true,
                  result: {
                    message_id: sent.length,
                    date: 0,
                    chat: { id: body.chat_id, type: "supergroup", title: "Topics" },
                    text: body.text,
                  },
                },
          ),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("flood-bare").transformer);
    const final = api.sendMessage(-100333, "final answer", { message_thread_id: 1 });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toHaveLength(1);
      // The reply is waiting out its pause; the preview neither sends nor queues.
      await expect(
        runReplaceableTelegramRequest(() =>
          api.editMessageText(-100333, 4, "preview", { message_thread_id: 2 } as never),
        ),
      ).rejects.toMatchObject({ error_code: 429 });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(final).resolves.toMatchObject({ text: "final answer" });
      expect(sent).toHaveLength(3);
      // Each bare 429 pauses about one second; repeated ones do not grow the wait.
      for (const gap of [sent[1]! - sent[0]!, sent[2]! - sent[1]!]) {
        expect(gap).toBeGreaterThanOrEqual(1_000);
        expect(gap).toBeLessThan(1_500);
      }
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.allSettled([final]);
      vi.useRealTimers();
    }
  });

  it("keeps the later deadline when overlapping 429s carry different retry_after", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const longFlood = deferred<Response>();
    const shortFlood = deferred<Response>();
    const sentAt = new Map<number, number>();
    const flood = (retryAfter: number) =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: `Too Many Requests: retry after ${retryAfter}`,
          parameters: { retry_after: retryAfter },
        }),
      );
    const api = new Api("123:flood-overlap", {
      buildUrl: (root, _token, method) => `${root}/${method}`,
      fetch: asTelegramClientFetch(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
        if (!sentAt.has(body.chat_id)) {
          sentAt.set(body.chat_id, Date.now() - startedAt);
          if (body.chat_id === 111) {
            return await longFlood.promise;
          }
          if (body.chat_id === 222) {
            return await shortFlood.promise;
          }
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1,
              date: 0,
              chat: { id: body.chat_id, type: "private", first_name: "Fixture" },
              text: body.text,
            },
          }),
        );
      }),
    });
    api.config.use(getOrCreateAccountThrottler("flood-overlap").transformer);
    const first = api.sendMessage(111, "first");
    const second = api.sendMessage(222, "second");
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect([...sentAt.keys()]).toEqual([111, 222]);
      longFlood.resolve(flood(10));
      await vi.advanceTimersByTimeAsync(0);
      // A shorter 429 that lands later must not shorten the active pause.
      shortFlood.resolve(flood(2));
      await vi.advanceTimersByTimeAsync(0);
      const third = api.sendMessage(333, "third");
      await vi.advanceTimersByTimeAsync(9_500);
      expect(sentAt.has(333)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(third).resolves.toMatchObject({ text: "third" });
      expect(sentAt.get(333)).toBeGreaterThanOrEqual(10_000);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    } finally {
      longFlood.resolve(flood(10));
      shortFlood.resolve(flood(2));
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
    }
  });

  it("round-robins group topic requests before entering the Telegram throttler", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "round-robin",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    ).transformer;
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_thread_id?: number; text?: string };
      entered.push(`${request.message_thread_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 10, text: "first" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["10:first"]));

    const secondSameTopic = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 10, text: "second" },
      undefined,
    );
    const otherTopic = throttler(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: 20, text: "other" },
      undefined,
    );
    await Promise.resolve();

    expect(entered).toEqual(["10:first"]);
    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("20:other");
    await Promise.all([first, secondSameTopic, otherTopic]);

    expect(entered).toEqual(["10:first", "20:other", "10:second"]);
  });

  it("uses edited message ids as lanes when Telegram omits topic ids", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "edited-message",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    ).transformer;
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_id?: number; text?: string };
      entered.push(`${request.message_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 101, text: "first-edit" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["101:first-edit"]));

    const secondSameMessage = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 101, text: "second-edit" },
      undefined,
    );
    const otherMessage = throttler(
      prev,
      "editMessageText",
      { chat_id: -100123, message_id: 202, text: "other-edit" },
      undefined,
    );

    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("202:other-edit");
    await Promise.all([first, secondSameMessage, otherMessage]);

    expect(entered).toEqual(["101:first-edit", "202:other-edit", "101:second-edit"]);
  });

  it("does not group-throttle fractional chat ids", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "direct-topic",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    ).transformer;
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { text?: string };
      entered.push(request.text ?? "");
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = throttler(
      prev,
      "sendMessage",
      { chat_id: "-100123.5", message_thread_id: 10, text: "first" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["first"]));

    const second = throttler(
      prev,
      "sendMessage",
      { chat_id: "-100123.5", message_thread_id: 20, text: "second" },
      undefined,
    );
    await vi.waitFor(() => expect(entered).toEqual(["first", "second"]));

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  it("uses strict decimal string ids for fair group lanes", async () => {
    const firstGate = deferred<void>();
    const entered: string[] = [];
    const throttler = getOrCreateAccountThrottler(
      "private-chat",
      () => async (prev, method, payload, signal) => prev(method, payload, signal),
    ).transformer;
    const prev = vi.fn(async (_method: string, payload: unknown) => {
      const request = payload as { message_thread_id?: string; text?: string };
      entered.push(`${request.message_thread_id}:${request.text}`);
      if (entered.length === 1) {
        await firstGate.promise;
      }
      return { ok: true, result: request.text ?? "" };
    }) as unknown as TelegramPreviousCall;

    const first = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "+10",
      text: "first",
    });
    await vi.waitFor(() => expect(entered).toEqual(["+10:first"]));

    const sameTopic = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "+10",
      text: "second",
    });
    const otherTopic = callLooseSendMessage(throttler, prev, {
      chat_id: "-100123",
      message_thread_id: "0x20",
      text: "hex",
    });

    firstGate.resolve();
    await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
    expect(entered[1]).toBe("0x20:hex");
    await Promise.all([first, sameTopic, otherTopic]);

    expect(entered).toEqual(["+10:first", "0x20:hex", "+10:second"]);
  });
});
