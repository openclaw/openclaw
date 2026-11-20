import { createRequire } from "node:module";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { getOrCreateAccountThrottler, releaseAccountThrottler } from "./account-throttler.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";

type Transformer = ReturnType<typeof getOrCreateAccountThrottler>["transformer"];
type Signal = Parameters<Transformer>[3];
const {
  AbortController: TelegramAbortController,
}: {
  AbortController: new () => { signal: NonNullable<Signal>; abort: () => void };
} = createRequire(import.meta.resolve("grammy"))("abort-controller");

beforeEach(() => resetTelegramAccountThrottlersForTest());

function fixture() {
  const held = createDeferred<void>();
  const sent: string[] = [];
  const pending: Promise<unknown>[] = [];
  const token = "queued-abort";
  const transformer = getOrCreateAccountThrottler(
    token,
    () => async (prev, method, payload, signal) => prev(method, payload, signal),
  ).transformer;
  const prev = vi.fn(async (_method: string, payload: unknown) => {
    sent.push((payload as { text: string }).text);
    if (sent.length === 1) {
      await held.promise;
    }
    return { ok: true, result: true };
  }) as unknown as Parameters<Transformer>[0];
  const send = (text: string, signal?: Signal, topic = 1) => {
    const request = transformer(
      prev,
      "sendMessage",
      { chat_id: -100123, message_thread_id: topic, text },
      signal,
    );
    pending.push(request);
    return request;
  };
  onTestFinished(async () => {
    held.resolve();
    await Promise.allSettled(pending);
    await releaseAccountThrottler(token);
  });
  return { held, sent, send, token };
}

it("promptly cancels queued requests behind a held predecessor without dispatching them", async () => {
  const { send, sent, held } = fixture();
  const first = send("first");
  const controllers = [new TelegramAbortController(), new TelegramAbortController()];
  const outcomes = controllers.map((controller, index) =>
    expect(send(`canceled-${index}`, controller.signal, index + 2)).rejects.toMatchObject({
      name: "AbortError",
    }),
  );
  controllers.forEach((controller) => controller.abort());
  await Promise.all(outcomes);
  expect(sent).toEqual(["first"]);
  const next = send("next");
  held.resolve();
  await Promise.all([first, next]);
  expect(sent).toEqual(["first", "next"]);
});

it("rejects an already-aborted request before queuing or attaching a listener", async () => {
  const { send, sent } = fixture();
  const controller = new TelegramAbortController();
  controller.abort();
  const add = vi.spyOn(controller.signal, "addEventListener");
  await expect(send("canceled", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
  expect(add).not.toHaveBeenCalled();
});

it("does not settle an already-started request when its signal aborts", async () => {
  const { send, sent, held } = fixture();
  const controller = new TelegramAbortController();
  const request = send("started", controller.signal);
  const settled = vi.fn();
  void request.then(settled, settled);
  controller.abort();
  await Promise.resolve();
  expect(sent).toEqual(["started"]);
  expect(settled).not.toHaveBeenCalled();
  held.resolve();
  await expect(request).resolves.toMatchObject({ ok: true });
});

it.each(["head", "middle"])(
  "preserves topic fairness when the queued %s is canceled",
  async (position) => {
    const { send, sent, held } = fixture();
    const controller = new TelegramAbortController();
    const first = send("first");
    const second = position === "middle" ? send("second") : undefined;
    const canceled = expect(send("canceled", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const third = send("third");
    const survivor = second ?? send("fourth");
    const other = send("other-topic", undefined, 2);
    controller.abort();
    await canceled;
    held.resolve();
    await Promise.all([first, survivor, third, other]);
    expect(sent).toEqual([
      "first",
      "other-topic",
      ...(second ? ["second", "third"] : ["third", "fourth"]),
    ]);
  },
);

it.each(["success", "abort", "retirement"] as const)(
  "detaches the queued abort listener on %s",
  async (outcome) => {
    const { send, held, token } = fixture();
    const first = send("first");
    const controller = new TelegramAbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const request = send("queued", controller.signal);
    const result =
      outcome === "success"
        ? expect(request).resolves.toMatchObject({ ok: true })
        : expect(request).rejects.toBeInstanceOf(Error);
    expect(add).toHaveBeenCalledOnce();
    if (outcome === "abort") {
      controller.abort();
    } else if (outcome === "retirement") {
      await releaseAccountThrottler(token);
    } else {
      held.resolve();
    }
    await result;
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
    held.resolve();
    await first;
  },
);
