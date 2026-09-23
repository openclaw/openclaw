import type * as Dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Bot, Context } from "grammy";
import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "../bot.create-telegram-bot.test-support.js";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { resolveMedia } from "./delivery.resolve-media.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof Dns>()),
  lookup,
}));

describe("Telegram media acquisition through grammY and the media store", () => {
  const fixture = useTelegramHttpFixture();
  let state: OpenClawTestState;
  let api: Api;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "telegram-media-acquisition" });
    api = new Bot(fixture.cfg.channels.telegram.botToken, {
      client: { apiRoot: fixture.cfg.channels.telegram.apiRoot },
    }).api;
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    fixture.responseFor = (method) =>
      method === "getFile" ? { file_id: "file", file_path: "photos/file.png" } : undefined;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await state.cleanup();
  });
  const context = (sticker = false) => {
    const ctx = new Context(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1736380800,
          chat: { id: 123, type: "private", first_name: "Ada" },
          from: { id: 123, is_bot: false, first_name: "Ada" },
          ...(sticker
            ? {
                sticker: {
                  file_id: "file",
                  file_unique_id: "unique",
                  type: "regular" as const,
                  width: 1,
                  height: 1,
                  is_animated: false,
                  is_video: false,
                },
              }
            : {
                document: { file_id: "file", file_unique_id: "unique", file_name: "original.png" },
              }),
        },
      },
      api,
      telegramBotInfoForTest,
    );
    if (!ctx.has("message")) {
      throw new Error("Expected Telegram media message");
    }
    return ctx;
  };

  it.each([false, true])(
    "bounds getFile retries and preserves actual bytes when recovery succeeds=%s",
    async (recovers) => {
      const responses = [createDeferred<void>(), createDeferred<void>()];
      let attempts = 0;
      api.config.use(async (previous, method, payload, signal) => {
        const result = await previous(method, payload, signal);
        if (method === "getFile") {
          responses[attempts]?.resolve();
          attempts += 1;
        }
        return result;
      });
      fixture.rejections.push(
        { error_code: 502, description: "Bad Gateway" },
        { error_code: 400, description: "Bad Request: file is temporarily unavailable" },
        ...(recovers ? [] : [{ error_code: 502, description: "Bad Gateway" }]),
      );
      const bytes = await readFile(fixture.photoPath);
      const sourceFetch = async () =>
        new Response(bytes, { headers: { "content-type": "image/png" } });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const acquiring = resolveMedia({
        ctx: context(),
        token: fixture.cfg.channels.telegram.botToken,
        apiRoot: fixture.cfg.channels.telegram.apiRoot,
        maxBytes: 1024,
        transport: { fetch: sourceFetch, sourceFetch, close: async () => {} },
      });
      const outcome = acquiring.then(
        (media) => ({ media }),
        (error: unknown) => ({ error }),
      );
      await responses[0]!.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await responses[1]!.promise;
      await vi.advanceTimersByTimeAsync(2000);
      const result = await outcome;
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "getFile",
        "getFile",
        "getFile",
      ]);
      if (recovers) {
        const media = await acquiring;
        expect(await readFile(media!.path)).toEqual(bytes);
        expect(media?.fileName).toBe("original.png");
      } else {
        expect(result).toMatchObject({ error: { code: "http_error", status: 502 } });
      }
    },
  );

  it.each([
    { code: 400, description: "Bad Request: file is too big", kind: "max_bytes" },
    { code: 403, description: "Forbidden", kind: "http_error" },
  ])("does not retry a permanent getFile $description", async ({ code, description, kind }) => {
    fixture.rejections.push({ error_code: code, description });
    await expect(
      resolveMedia({ ctx: context(), token: "fixture", maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: kind, status: code });
    expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile"]);
  });

  it.each(["retry", "shutdown", "deadline"] as const)(
    "retains Telegram flood-wait custody through %s",
    async (mode) => {
      const response = createDeferred<void>();
      api.config.use(async (previous, method, payload, signal) => {
        const result = await previous(method, payload, signal);
        if (method === "getFile" && !result.ok) {
          response.resolve();
        }
        return result;
      });
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: mode === "deadline" ? 1200 : 60 },
      });
      const abort = new AbortController();
      const bytes = await readFile(fixture.photoPath);
      const sourceFetch = async () =>
        new Response(bytes, { headers: { "content-type": "image/png" } });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const acquiring = resolveMedia({
        ctx: context(),
        token: "fixture",
        apiRoot: fixture.cfg.channels.telegram.apiRoot,
        maxBytes: 1024,
        abortSignal: abort.signal,
        transport: { fetch: sourceFetch, sourceFetch, close: async () => {} },
      });
      const outcome = acquiring.then(
        (media) => ({ media }),
        (error: unknown) => ({ error }),
      );
      await response.promise;
      if (mode === "retry") {
        await vi.advanceTimersByTimeAsync(59999);
        expect(fixture.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({
          media: { kind: "document", contentType: "image/png" },
        });
        expect(fixture.requests).toHaveLength(2);
      } else {
        if (mode === "shutdown") {
          abort.abort();
        } else {
          await vi.advanceTimersByTimeAsync(1200000);
        }
        expect(await outcome).toMatchObject({ error: { code: "http_error", status: 429 } });
        expect(fixture.requests).toHaveLength(1);
      }
    },
  );

  it.each([false, true])(
    "cancels an in-progress media body rather than saving partial bytes (sticker: %s)",
    async (sticker) => {
      const reading = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
      const abort = new AbortController();
      let downloads = 0;
      const sourceFetch: typeof fetch = async (_url, init) => {
        downloads++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([137, 80, 78, 71]));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
              reading.resolve(controller);
            },
          }),
          { headers: { "content-type": "image/png" } },
        );
      };
      const acquiring = resolveMedia({
        ctx: context(sticker),
        token: "fixture",
        apiRoot: fixture.cfg.channels.telegram.apiRoot,
        maxBytes: 1024,
        abortSignal: abort.signal,
        transport: { fetch: sourceFetch, sourceFetch, close: async () => {} },
      });
      const failure = expect(acquiring).rejects.toMatchObject({ code: "fetch_failed" });
      await reading.promise;
      abort.abort(new Error("session stopped"));
      await failure;
      expect(downloads).toBe(1);
      expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile"]);
    },
  );

  it.each(["default", "private-opt-in", "explicit-proxy"] as const)(
    "enforces private-address trust at the real fetch guard (%s)",
    async (policy) => {
      const bytes = await readFile(fixture.photoPath);
      let fetched = 0;
      const sourceFetch = async () => {
        fetched++;
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      };
      const acquiring = resolveMedia({
        ctx: context(),
        token: "fixture",
        maxBytes: 1024,
        ...(policy === "private-opt-in" ? { dangerouslyAllowPrivateNetwork: true } : {}),
        transport: {
          fetch: sourceFetch,
          sourceFetch,
          close: async () => {},
          ...(policy === "explicit-proxy"
            ? {
                dispatcherAttempts: [
                  {
                    dispatcherPolicy: {
                      mode: "explicit-proxy" as const,
                      proxyUrl: "http://localhost:8888",
                      allowPrivateProxy: true,
                    },
                  },
                ],
              }
            : {}),
        },
      });
      if (policy === "default") {
        await expect(acquiring).rejects.toThrow(/private|blocked/i);
        expect(fetched).toBe(0);
      } else {
        const media = await acquiring;
        expect(await readFile(media!.path)).toEqual(bytes);
        expect(fetched).toBe(1);
      }
    },
  );
});
