import { AsyncLocalStorage } from "node:async_hooks";
import { Api } from "grammy";
import { expect, it } from "vitest";
import {
  getOrCreateAccountThrottler,
  releaseAccountThrottler,
  runAuthorizedTelegramRequest,
} from "./account-throttler.js";
import { asTelegramClientFetch } from "./client-fetch.js";

it.each([42, -100123])("keeps queued sends in their caller context for chat %s", async (chatId) => {
  const callers = new AsyncLocalStorage<AbortSignal>();
  const firstCaller = new AbortController();
  const nextCaller = new AbortController();
  const firstEntered = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<Response>();
  const token = `caller-context-${chatId}`;
  const sent: string[] = [];
  const messageResponse = (text: string) =>
    new Response(JSON.stringify({ ok: true, result: { text } }));
  const api = callers.run(firstCaller.signal, () => {
    const client = new Api(`123:${token}`, {
      fetch: asTelegramClientFetch(async (_input: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        sent.push(body.text);
        if (sent.length === 1) {
          firstEntered.resolve();
          return firstResponse.promise;
        }
        return messageResponse(body.text);
      }),
    });
    client.config.use(getOrCreateAccountThrottler(token).transformer);
    return client;
  });
  try {
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
    expect(sent).toEqual(["first", "second"]);
  } finally {
    firstResponse.resolve(messageResponse("first"));
    await releaseAccountThrottler(token);
  }
});
