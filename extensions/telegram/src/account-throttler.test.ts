import { createRequire } from "node:module";
import { Api } from "grammy";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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

function finishClock(
  ms: number,
  settle: () => Promise<unknown> = async () => {},
  release = () => {},
) {
  onTestFinished(async () => {
    try {
      release();
      await tick(ms);
      await settle();
    } finally {
      vi.useRealTimers();
    }
  });
}
const typing = (
  api: Api,
  thread: number,
  signal?: Parameters<Api["sendChatAction"]>[3],
  chat = -100123,
) => api.sendChatAction(chat, "typing", { message_thread_id: thread }, signal);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const success = { ok: true, result: true };
const unauthorized = { ok: false, error_code: 401, description: "Unauthorized" };
const response = (body: unknown) => new Response(JSON.stringify(body));
const messageResponse = (text?: string) => response({ ok: true, result: { text } });
const flood = (seconds?: number) =>
  response({
    ok: false,
    error_code: 429,
    description:
      seconds === undefined ? "Too Many Requests" : `Too Many Requests: retry after ${seconds}`,
    ...(seconds === undefined ? {} : { parameters: { retry_after: seconds } }),
  });
type SentCall = { chatId: number; text?: string; method: string; at: number };
function floodApi(token: string, reject: (call: SentCall, count: number) => Response | undefined) {
  const startedAt = Date.now(),
    sent: SentCall[] = [];
  const api = createApi(token, true, async (input: unknown, init?: { body?: unknown }) => {
    assert(typeof input === "string");
    const body = JSON.parse(String(init?.body)) as { chat_id: number; text?: string };
    const call = {
      chatId: body.chat_id,
      text: body.text,
      method: input.slice(input.lastIndexOf("/") + 1),
      at: Date.now() - startedAt,
    };
    sent.push(call);
    return reject(call, sent.length) ?? messageResponse(body.text);
  });
  return { api, sent };
}

function createApi(
  token: string,
  directUrl: boolean,
  fetch: Parameters<typeof asTelegramClientFetch>[0],
) {
  const api = new Api(`123:${token}`, {
    fetch: asTelegramClientFetch(fetch),
    ...(directUrl
      ? { buildUrl: (root: string, _token: string, method: string) => `${root}/${method}` }
      : {}),
  });
  api.config.use(getOrCreateAccountThrottler(token).transformer);
  return api;
}
function laneProbe(
  token: string,
  format: (payload: { message_id?: number; message_thread_id?: string; text?: string }) => string,
) {
  const firstGate = deferred<void>();
  const entered: string[] = [];
  const throttler = getOrCreateAccountThrottler(
    token,
    () => async (prev, method, payload, signal) => prev(method, payload, signal),
  ).transformer;
  const prev = vi.fn(async (_method: string, payload: unknown) => {
    const request = payload as Parameters<typeof format>[0];
    entered.push(format(request));
    if (entered.length === 1) {
      await firstGate.promise;
    }
    return { ok: true, result: request.text ?? "" };
  }) as unknown as TelegramPreviousCall;
  return { firstGate, entered, throttler, prev };
}

beforeEach(() => {
  resetTelegramAccountThrottlersForTest();
});

it("preserves the group message budget while sending topic actions", async () => {
  vi.useFakeTimers();
  const sent: string[] = [];
  const api = createApi("typing-budget", true, async (input: unknown) => {
    assert(typeof input === "string");
    const url = input;
    const method = url.slice(url.lastIndexOf("/") + 1);
    sent.push(method);
    return method === "sendChatAction" ? response(success) : messageResponse("Complete");
  });
  const actions = Array.from({ length: 21 }, (_, index) => typing(api, index + 1));
  const replies = Array.from({ length: 21 }, () => api.sendMessage(-100123, "Complete"));
  finishClock(180_000, () => Promise.all([...actions, ...replies]));
  await tick(100);
  expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(1);
  await tick(21_000);
  expect(sent.filter((method) => method === "sendChatAction")).toHaveLength(21);
  expect(sent.filter((method) => method === "sendMessage")).toHaveLength(20);
  await tick(40_000);
  expect(sent.filter((method) => method === "sendMessage")).toHaveLength(21);
});

it("shares suspension and recovery across clients for the same token", async () => {
  vi.useFakeTimers();
  let sent = 0;
  const fetch = asTelegramClientFetch(async () => {
    sent++;
    return response(sent <= 10 ? unauthorized : success);
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
  finishClock(600_000, () => results);
  await tick(600_000);
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect(sent).toBe(10);
  expect(account.chatActions.isSuspended()).toBe(true);
  account.chatActions.reset();
  const recovered = typing(second, 12);
  await tick(1_000);
  await recovered;
  expect(sent).toBe(11);
});

it.each([
  { name: "flood wait", errorCode: 429, secondStatus: "rejected" },
  { name: "authorization backoff", errorCode: 401, secondStatus: "fulfilled" },
])("rechecks $name before sending a queued topic action", async ({ errorCode, secondStatus }) => {
  vi.useFakeTimers();
  const sent: number[] = [];
  const startedAt = Date.now();
  const api = new Api("123:queued-failure", {
    fetch: asTelegramClientFetch(async () => {
      sent.push(Date.now() - startedAt);
      return response(
        sent.length === 1
          ? {
              ok: false,
              error_code: errorCode,
              description: errorCode === 429 ? "Too Many Requests" : "Unauthorized",
              ...(errorCode === 429 ? { parameters: { retry_after: 20 } } : {}),
            }
          : success,
      );
    }),
  });
  const account = getOrCreateAccountThrottler("queued-failure");
  api.config.use(account.transformer);
  const first = typing(api, 10);
  const second = typing(api, 20);
  const results = Promise.allSettled([first, second]);
  finishClock(25_000, () => results);
  await tick(1_500);
  expect(sent).toHaveLength(1);
  await tick(1_000);
  expect((await results).map((result) => result.status)).toEqual(["rejected", secondStatus]);
  if (secondStatus === "fulfilled") {
    expect(sent[1]).toBeGreaterThanOrEqual(1_900);
    const nextTopic = typing(api, 40);
    await tick(0);
    expect(sent).toHaveLength(2);
    await tick(1_000);
    await nextTopic;
    const [, previousAt, nextAt] = sent;
    assert(previousAt !== undefined && nextAt !== undefined);
    expect(nextAt - previousAt).toBeGreaterThanOrEqual(1_000);
  }
  await tick(20_000);
  account.chatActions.reset();
  const recovered = typing(api, 30);
  await tick(1_000);
  await recovered;
  expect(sent).toHaveLength(secondStatus === "fulfilled" ? 4 : 2);
});

it("releases a topic action canceled during authorization backoff", async () => {
  vi.useFakeTimers();
  let sent = 0;
  const api = createApi("canceled-backoff", false, async () => {
    sent++;
    return response(sent === 1 ? unauthorized : success);
  });
  const first = typing(api, 1);
  const failed = expect(first).rejects.toThrow("Unauthorized");
  await tick(0);
  await failed;
  const controller = new TelegramAbortController();
  const canceled = typing(api, 2, controller.signal);
  const settled = vi.fn();
  const outcome = canceled.then(settled, settled);
  finishClock(10_000, () => outcome);
  await tick(1_500);
  controller.abort();
  await tick(0);
  expect(settled).toHaveBeenCalledOnce();
  expect(sent).toBe(1);
  const recovered = typing(api, 3);
  await tick(3_000);
  await recovered;
  expect(sent).toBe(2);
});

it.each(["group queue", "authorization queue"])(
  "settles cancellation in the %s without releasing an active predecessor",
  async (queue) => {
    vi.useFakeTimers();
    const authorization = queue === "authorization queue";
    const held = deferred<Response>();
    let sent = 0;
    const api = createApi("queued-wait", false, async () => {
      sent++;
      if (authorization && sent === 1) {
        return response(unauthorized);
      }
      if (sent === (authorization ? 2 : 1)) {
        return held.promise;
      }
      return response(success);
    });
    if (authorization) {
      const failed = expect(api.sendChatAction(-100123, "typing")).rejects.toThrow("Unauthorized");
      await tick(0);
      await failed;
    }
    const predecessor = typing(api, 1);
    await tick(authorization ? 2_200 : 0);
    const controller = new TelegramAbortController();
    const canceled = typing(api, 2, controller.signal, authorization ? -100456 : -100123);
    const settled = vi.fn();
    const outcome = canceled.then(settled, settled);
    const successor = typing(api, 3, undefined, authorization ? -100789 : -100123);
    finishClock(
      10_000,
      () => Promise.all([predecessor, outcome, successor]),
      () => {
        held.resolve(response(success));
      },
    );
    await tick(0);
    controller.abort();
    await tick(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(sent).toBe(authorization ? 2 : 1);
    held.resolve(response(success));
    await tick(2_000);
    await Promise.all([predecessor, successor]);
    expect(sent).toBe(authorization ? 3 : 2);
  },
);

it("does not spend action spacing on canceled requests", async () => {
  vi.useFakeTimers();
  const sent: number[] = [];
  const api = new Api("123:canceled-actions", {
    fetch: asTelegramClientFetch(async () => {
      sent.push(Date.now());
      return response(success);
    }),
  });
  api.config.use((prev, method, payload, signal) => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return prev(method, payload, signal);
  });
  api.config.use(getOrCreateAccountThrottler("canceled-actions").transformer);
  const first = typing(api, 1);
  await tick(0);
  await first;
  const controllers = Array.from({ length: 5 }, () => new TelegramAbortController());
  const canceled = controllers.map((controller, index) =>
    typing(api, index + 2, controller.signal),
  );
  const results = Promise.allSettled(canceled);
  const next = typing(api, 10);
  finishClock(10_000, () => Promise.all([results, next]));
  await tick(100);
  controllers.forEach((controller) => controller.abort());
  await tick(900);
  expect(sent).toHaveLength(2);
  const [firstAt, nextAt] = sent;
  assert(firstAt !== undefined && nextAt !== undefined);
  expect(nextAt - firstAt).toBe(1_000);
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  await next;
});

it("holds every chat on the token for a flood wait and skips previews until it clears", async () => {
  vi.useFakeTimers();
  const { api, sent } = floodApi("flood-gate", (_call, count) =>
    count === 1 ? flood(7) : undefined,
  );
  const final = api.sendMessage(-100111, "final answer", { message_thread_id: 5 });
  await tick(100);
  expect(sent.map(({ text }) => text)).toEqual(["final answer"]);

  const otherChat = api.sendMessage(-100222, "other chat reply");
  const preview = runReplaceableTelegramRequest(() =>
    api.editMessageText(-100222, 9, "preview while flooded"),
  );
  await expect(preview).rejects.toMatchObject({ error_code: 429 });
  finishClock(60_000, () => Promise.allSettled([final, otherChat]));
  await tick(6_800);
  expect(sent).toHaveLength(1);
  await tick(2_000);
  await expect(final).resolves.toMatchObject({ text: "final answer" });
  await expect(otherChat).resolves.toMatchObject({ text: "other chat reply" });
  expect(sent.map(({ text }) => text)).toEqual([
    "final answer",
    "final answer",
    "other chat reply",
  ]);
  expect(sent.slice(1).every(({ at }) => at >= 7_000)).toBe(true);
});

it("lets a typing flood wait hold replies in another chat on the same token", async () => {
  vi.useFakeTimers();
  const { api, sent } = floodApi("typing-flood", ({ method }) =>
    method === "sendChatAction" ? flood(6) : undefined,
  );
  finishClock(60_000);
  await expect(api.sendChatAction(-100111, "typing")).rejects.toMatchObject({
    error_code: 429,
  });
  const reply = api.sendMessage(-100222, "final answer");
  await tick(5_500);
  expect(sent.map(({ method }) => method)).toEqual(["sendChatAction"]);
  await tick(1_000);
  await expect(reply).resolves.toMatchObject({ text: "final answer" });
  expect(sent[1]).toMatchObject({ method: "sendMessage" });
  expect(sent[1]!.at).toBeGreaterThanOrEqual(6_000);
});

it("pauses a fixed second for a 429 without retry_after and yields previews to the reply", async () => {
  vi.useFakeTimers();
  const { api, sent } = floodApi("flood-bare", (_call, count) =>
    count <= 2 ? flood() : undefined,
  );
  const final = api.sendMessage(-100333, "final answer", { message_thread_id: 1 });
  finishClock(60_000, () => Promise.allSettled([final]));
  await tick(100);
  expect(sent).toHaveLength(1);
  await expect(
    runReplaceableTelegramRequest(() =>
      api.editMessageText(-100333, 4, "preview", { message_thread_id: 2 } as never),
    ),
  ).rejects.toMatchObject({ error_code: 429 });
  await tick(5_000);
  await expect(final).resolves.toMatchObject({ text: "final answer" });
  expect(sent).toHaveLength(3);
  for (const gap of [sent[1]!.at - sent[0]!.at, sent[2]!.at - sent[1]!.at]) {
    expect(gap).toBeGreaterThanOrEqual(1_000);
    expect(gap).toBeLessThan(1_500);
  }
});

it("keeps the later deadline when overlapping 429s carry different retry_after", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const longFlood = deferred<Response>();
  const shortFlood = deferred<Response>();
  const sentAt = new Map<number, number>();
  const api = createApi(
    "flood-overlap",
    true,
    async (_input: unknown, init?: { body?: unknown }) => {
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
      return messageResponse(body.text);
    },
  );
  const first = api.sendMessage(111, "first");
  const second = api.sendMessage(222, "second");
  finishClock(60_000, undefined, () => {
    longFlood.resolve(flood(10));
    shortFlood.resolve(flood(2));
  });
  await tick(100);
  expect([...sentAt.keys()]).toEqual([111, 222]);
  longFlood.resolve(flood(10));
  await tick(0);
  shortFlood.resolve(flood(2));
  await tick(0);
  const third = api.sendMessage(333, "third");
  await tick(9_500);
  expect(sentAt.has(333)).toBe(false);
  await tick(2_000);
  await expect(third).resolves.toMatchObject({ text: "third" });
  expect(sentAt.get(333)).toBeGreaterThanOrEqual(10_000);
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});

it.each(["edited-message", "string-topic"])("uses %s ids for fair group lanes", async (kind) => {
  const edited = kind === "edited-message";
  const expected = edited
    ? ["101:first", "202:other", "101:second"]
    : ["+10:first", "0x20:other", "+10:second"];
  const { firstGate, entered, throttler, prev } = laneProbe(
    kind,
    (request) => `${edited ? request.message_id : request.message_thread_id}:${request.text}`,
  );
  const send = (other: boolean, text: string) =>
    edited
      ? throttler(
          prev,
          "editMessageText",
          { chat_id: -100123, message_id: other ? 202 : 101, text },
          undefined,
        )
      : callLooseSendMessage(throttler, prev, {
          chat_id: "-100123",
          message_thread_id: other ? "0x20" : "+10",
          text,
        });
  const first = send(false, "first");
  await vi.waitFor(() => expect(entered).toEqual([expected[0]]));
  const sameLane = send(false, "second");
  const otherLane = send(true, "other");
  firstGate.resolve();
  await vi.waitFor(() => expect(entered.length).toBeGreaterThanOrEqual(2));
  expect(entered[1]).toBe(expected[1]);
  await Promise.all([first, sameLane, otherLane]);
  expect(entered).toEqual(expected);
});

it("does not group-throttle fractional chat ids", async () => {
  const { firstGate, entered, throttler, prev } = laneProbe(
    "direct-topic",
    (request) => request.text ?? "",
  );

  const send = (message_thread_id: number, text: string) =>
    throttler(prev, "sendMessage", { chat_id: "-100123.5", message_thread_id, text }, undefined);
  const first = send(10, "first");
  await vi.waitFor(() => expect(entered).toEqual(["first"]));

  const second = send(20, "second");
  await vi.waitFor(() => expect(entered).toEqual(["first", "second"]));

  firstGate.resolve();
  await Promise.all([first, second]);
});
