import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { Api } from "grammy";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import { assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  getOrCreateAccountThrottler,
  releaseAccountThrottler,
  runAuthorizedTelegramRequest,
  runReplaceableTelegramRequest,
} from "./account-throttler.js";
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
function floodApi(
  token: string,
  reject: (call: SentCall, count: number) => Response | Promise<Response> | undefined,
) {
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
function actionApi(
  token: string,
  respond: (count: number) => Response | Promise<Response> = () => response(success),
) {
  const sent: number[] = [];
  const fetch = async () => {
    sent.push(Date.now());
    return respond(sent.length);
  };
  return { api: createApi(token, false, fetch), sent, fetch: asTelegramClientFetch(fetch) };
}

function gatedCall(
  format: (payload: { message_id?: number; message_thread_id?: string; text?: string }) => string,
) {
  const firstGate = deferred<void>();
  const entered: string[] = [];
  const prev = vi.fn(async (_method: string, payload: unknown) => {
    const request = payload as Parameters<typeof format>[0];
    entered.push(format(request));
    if (entered.length === 1) {
      await firstGate.promise;
    }
    return { ok: true, result: request.text ?? "" };
  }) as unknown as TelegramPreviousCall;
  return { firstGate, entered, prev };
}

function laneProbe(
  token: string,
  format: (payload: { message_id?: number; message_thread_id?: string; text?: string }) => string,
) {
  const throttler = getOrCreateAccountThrottler(
    token,
    () => async (prev, method, payload, signal) => prev(method, payload, signal),
  ).transformer;
  return { ...gatedCall(format), throttler };
}

beforeEach(() => {
  resetTelegramAccountThrottlersForTest();
});

it.each([42, -100123])("keeps queued sends in their caller context for chat %s", async (chatId) => {
  const callers = new AsyncLocalStorage<AbortSignal>();
  const firstCaller = new AbortController();
  const nextCaller = new AbortController();
  const firstEntered = deferred<void>();
  const firstResponse = deferred<Response>();
  const token = `caller-context-${chatId}`;
  const { api, sent } = callers.run(firstCaller.signal, () =>
    floodApi(token, (_call, count) => {
      if (count === 1) {
        firstEntered.resolve();
        return firstResponse.promise;
      }
      return undefined;
    }),
  );
  onTestFinished(async () => {
    firstResponse.resolve(messageResponse("first"));
    await releaseAccountThrottler(token);
  });
  const first = callers.run(firstCaller.signal, () => api.sendMessage(chatId, "first"));
  await firstEntered.promise;
  const assertNextCaller = () => {
    callers.getStore()?.throwIfAborted();
    expect(callers.getStore()).toBe(nextCaller.signal);
  };
  const sendNext = (text: string) =>
    callers.run(nextCaller.signal, () =>
      runAuthorizedTelegramRequest(assertNextCaller, () => api.sendMessage(chatId, text)),
    );
  const next = Promise.allSettled([sendNext("second")]);
  firstResponse.resolve(messageResponse("first"));
  await first;
  firstCaller.abort();
  expect(await next).toEqual([{ status: "fulfilled", value: { text: "second" } }]);

  nextCaller.abort();
  await expect(sendNext("revoked")).rejects.toMatchObject({ name: "AbortError" });
  expect(sent.map(({ text }) => text)).toEqual(["first", "second"]);
});

it("preserves the group message budget while sending topic actions", async () => {
  vi.useFakeTimers();
  const { api, sent } = floodApi("typing-budget", ({ method }) =>
    method === "sendChatAction" ? response(success) : undefined,
  );
  const actions = Array.from({ length: 21 }, (_, index) => typing(api, index + 1));
  const replies = Array.from({ length: 21 }, () => api.sendMessage(-100123, "Complete"));
  finishClock(180_000, () => Promise.all([...actions, ...replies]));
  await tick(100);
  expect(sent.filter(({ method }) => method === "sendChatAction")).toHaveLength(1);
  await tick(21_000);
  expect(sent.filter(({ method }) => method === "sendChatAction")).toHaveLength(21);
  expect(sent.filter(({ method }) => method === "sendMessage")).toHaveLength(20);
  await tick(40_000);
  expect(sent.filter(({ method }) => method === "sendMessage")).toHaveLength(21);
});

it("shares suspension and recovery across clients for the same token", async () => {
  vi.useFakeTimers();
  const {
    api: first,
    sent,
    fetch,
  } = actionApi("shared-failures", (count) => response(count <= 10 ? unauthorized : success));
  const second = new Api("123:shared-failures", { fetch });
  const account = getOrCreateAccountThrottler("shared-failures");
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
  expect(sent).toHaveLength(10);
  expect(account.chatActions.isSuspended()).toBe(true);
  account.chatActions.reset();
  const recovered = typing(second, 12);
  await tick(1_000);
  await recovered;
  expect(sent).toHaveLength(11);
});

it.each([
  { name: "flood wait", errorCode: 429, secondStatus: "rejected" },
  { name: "authorization backoff", errorCode: 401, secondStatus: "fulfilled" },
])("rechecks $name before sending a queued topic action", async ({ errorCode, secondStatus }) => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const { api, sent } = actionApi("queued-failure", (count) =>
    count === 1 ? (errorCode === 429 ? flood(20) : response(unauthorized)) : response(success),
  );
  const account = getOrCreateAccountThrottler("queued-failure");
  const first = typing(api, 10);
  const second = typing(api, 20);
  const results = Promise.allSettled([first, second]);
  finishClock(25_000, () => results);
  await tick(1_500);
  expect(sent).toHaveLength(1);
  await tick(1_000);
  expect((await results).map((result) => result.status)).toEqual(["rejected", secondStatus]);
  if (secondStatus === "fulfilled") {
    expect(sent[1]! - startedAt).toBeGreaterThanOrEqual(1_900);
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

it.each(["authorization backoff", "group queue", "authorization queue"])(
  "settles cancellation in the %s and preserves the next action",
  async (queue) => {
    vi.useFakeTimers();
    const backoff = queue === "authorization backoff";
    const authorization = queue !== "group queue";
    const dispatched = authorization && !backoff ? 2 : 1;
    const held = deferred<Response>();
    const { api, sent } = actionApi("queued-wait", (count) => {
      if (authorization && count === 1) {
        return response(unauthorized);
      }
      if (!backoff && count === dispatched) {
        return held.promise;
      }
      return response(success);
    });
    if (authorization) {
      const failed = expect(
        backoff ? typing(api, 1) : api.sendChatAction(-100123, "typing"),
      ).rejects.toThrow("Unauthorized");
      await tick(0);
      await failed;
    }
    const predecessor = backoff ? undefined : typing(api, 1);
    await tick(authorization && !backoff ? 2_200 : 0);
    const controller = new TelegramAbortController();
    const canceled = typing(
      api,
      2,
      controller.signal,
      queue === "authorization queue" ? -100456 : -100123,
    );
    const settled = vi.fn();
    const outcome = canceled.then(settled, settled);
    const successor = backoff
      ? undefined
      : typing(api, 3, undefined, authorization ? -100789 : -100123);
    finishClock(
      10_000,
      () => Promise.all([predecessor, outcome, successor]),
      () => held.resolve(response(success)),
    );
    await tick(backoff ? 1_500 : 0);
    controller.abort();
    await tick(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(dispatched);
    held.resolve(response(success));
    const recovered = backoff ? typing(api, 3) : successor;
    await tick(backoff ? 3_000 : 2_000);
    await Promise.all([predecessor, recovered]);
    expect(sent).toHaveLength(dispatched + 1);
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
  const longFlood = deferred<Response>();
  const shortFlood = deferred<Response>();
  const pending = new Map([
    [111, longFlood],
    [222, shortFlood],
  ]);
  const { api, sent } = floodApi("flood-overlap", ({ chatId }) => {
    const held = pending.get(chatId);
    pending.delete(chatId);
    return held?.promise;
  });
  const first = api.sendMessage(111, "first");
  const second = api.sendMessage(222, "second");
  finishClock(60_000, undefined, () => {
    longFlood.resolve(flood(10));
    shortFlood.resolve(flood(2));
  });
  await tick(100);
  expect(sent.map(({ chatId }) => chatId)).toEqual([111, 222]);
  longFlood.resolve(flood(10));
  await tick(0);
  shortFlood.resolve(flood(2));
  await tick(0);
  const third = api.sendMessage(333, "third");
  await tick(9_500);
  expect(sent.some(({ chatId }) => chatId === 333)).toBe(false);
  await tick(2_000);
  await expect(third).resolves.toMatchObject({ text: "third" });
  expect(sent.find(({ chatId }) => chatId === 333)?.at).toBeGreaterThanOrEqual(10_000);
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

describe("releaseAccountThrottler", () => {
  it.each([42, "-100123"])(
    "settles queued sends and rejects retired work for chat %s",
    async (chatId) => {
      vi.useFakeTimers();
      const fakeSetInterval = globalThis.setInterval;
      const fakeClearInterval = globalThis.clearInterval;
      const live = new Set<ReturnType<typeof setInterval>>();
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const handle = fakeSetInterval(...args);
        live.add(handle);
        return handle;
      }) as typeof setInterval;
      globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
        if (handle !== undefined) {
          live.delete(handle);
        }
        return fakeClearInterval(handle);
      }) as typeof clearInterval;
      const { firstGate, entered, prev } = gatedCall((request) => request.text ?? "");
      try {
        const account = getOrCreateAccountThrottler("settle-release");
        const send = (text: string) =>
          callLooseSendMessage(account.transformer, prev, { chat_id: chatId, text });
        const first = send("first");
        await tick(1_000);
        expect(entered).toEqual(["first"]);
        expect(live.size).toBeGreaterThan(0);
        const rejected = expect(send("queued")).rejects.toThrow(
          chatId === 42 ? /stopped/i : /released/i,
        );
        const releasing = releaseAccountThrottler("settle-release");
        await tick(0);
        await rejected;
        firstGate.resolve();
        await tick(1_000);
        await first;
        await expect(releasing).resolves.toBe(true);
        await expect(releaseAccountThrottler("settle-release")).resolves.toBe(false);
        expect(live.size).toBe(0);
        await expect(send("after-release")).rejects.toThrow(/released/i);
        await expect(
          account.transformer(
            prev,
            "sendChatAction",
            { chat_id: chatId, action: "typing" },
            undefined,
          ),
        ).rejects.toThrow(/released/i);
        expect(getOrCreateAccountThrottler("settle-release")).not.toBe(account);
      } finally {
        firstGate.resolve();
        globalThis.setInterval = fakeSetInterval;
        globalThis.clearInterval = fakeClearInterval;
        vi.useRealTimers();
      }
    },
  );

  it.each(["pacing", "running predecessor"])(
    "settles an action behind %s on retirement",
    async (wait) => {
      vi.useFakeTimers();
      const held = deferred<Response>();
      const { api, sent } = actionApi("action-retire", (count) =>
        count === 1 && wait === "running predecessor" ? held.promise : response(success),
      );
      const first = typing(api, 1);
      finishClock(
        2_000,
        () => Promise.allSettled([first]),
        () => held.resolve(response(success)),
      );
      await tick(0);
      if (wait === "pacing") {
        await first;
      }
      expect(sent).toHaveLength(1);
      const second = typing(api, 2);
      const rejected = expect(second).rejects.toThrow(/released/i);
      if (wait === "pacing") {
        await tick(100);
      }
      const releasing = releaseAccountThrottler("action-retire");
      await tick(0);
      await rejected;
      held.resolve(response(success));
      await tick(2_000);
      await first;
      await releasing;
      expect(sent).toHaveLength(1);
    },
  );

  it.each([-100123, 42])("settles a backing-off action immediately for chat %s", async (chatId) => {
    vi.useFakeTimers();
    const group = chatId < 0;
    const { api, sent } = actionApi("backoff-retire", (count) =>
      response(group && count > 1 ? success : unauthorized),
    );
    const send = (thread: number) =>
      group ? typing(api, thread) : api.sendChatAction(chatId, "typing");
    const failed = Array.from({ length: group ? 1 : 4 }, () =>
      expect(send(1)).rejects.toThrow("Unauthorized"),
    );
    if (group) {
      await tick(0);
      await Promise.all(failed);
    }
    const second = send(2);
    const settled = vi.fn();
    const outcome = second.then(settled, settled);
    finishClock(600_000, () => Promise.allSettled([...failed, outcome]));
    await tick(group ? 1_500 : 9_500);
    await Promise.all(failed);
    expect(sent).toHaveLength(group ? 1 : 4);
    const releasing = releaseAccountThrottler("backoff-retire");
    await tick(group ? 0 : 10);
    expect(settled).toHaveBeenCalledOnce();
    await expect(second).rejects.toThrow(/released/i);
    await releasing;
    await tick(600_000);
    expect(sent).toHaveLength(group ? 1 : 4);
    await outcome;
  });
});
