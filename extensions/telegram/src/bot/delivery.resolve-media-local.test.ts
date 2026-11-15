import type * as Dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { Bot, Context } from "grammy";
import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "../bot.create-telegram-bot.test-support.js";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

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
  const context = () => {
    const ctx = new Context(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1736380800,
          chat: { id: 123, type: "private", first_name: "Ada" },
          from: { id: 123, is_bot: false, first_name: "Ada" },
          document: { file_id: "file", file_unique_id: "unique", file_name: "original.png" },
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

  it("preserves actual bytes and the original filename after getFile recovery", async () => {
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
    await responses[0]!.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await responses[1]!.promise;
    await vi.advanceTimersByTimeAsync(2000);
    const media = await acquiring;
    expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile", "getFile", "getFile"]);
    expect(await readFile(media!.path)).toEqual(bytes);
    expect(media?.fileName).toBe("original.png");
  });

  it("does not retry a getFile size rejection", async () => {
    fixture.rejections.push({ error_code: 400, description: "Bad Request: file is too big" });
    await expect(
      resolveMedia({ ctx: context(), token: "fixture", maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "max_bytes", status: 400 });
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
          media: { contentType: "image/png" },
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

  it("cancels an in-progress media body rather than saving partial bytes", async () => {
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
      ctx: context(),
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
  });

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

describe("Telegram downloaded image documents", () => {
  it("detects JPEG bytes in a document with generic metadata", async () => {
    const JPEG = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
      "base64",
    );
    const fixture = {
      bytes: JPEG,
      fileName: "upload.bin",
      mimeType: "application/octet-stream",
      contentType: "image/jpeg",
      kind: "image",
    };
    await withOpenClawTestState({ label: "telegram-image-document" }, async (state) => {
      const sourcePath = state.path(fixture.fileName);
      await writeFile(sourcePath, fixture.bytes);
      const fileId = "document-fixture";
      const ctx: TelegramContext = {
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private", first_name: "Fixture" },
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: fixture.fileName,
            mime_type: fixture.mimeType,
          },
        },
        getFile: async () => ({
          file_id: fileId,
          file_unique_id: fileId,
          file_path: sourcePath,
        }),
      };
      const result = await resolveMedia({
        ctx,
        token: "12345:fixture-token",
        maxBytes: 1_024,
        trustedLocalFileRoots: [state.root],
      });

      expect(result).not.toBeNull();
      if (!result) {
        throw new Error("Expected the document to be saved");
      }
      expect(result.path).not.toBe(sourcePath);
      expect(await readFile(result.path)).toEqual(fixture.bytes);
      expect(result).toMatchObject({
        contentType: fixture.contentType,
        fileName: fixture.fileName,
        size: fixture.bytes.length,
        kind: fixture.kind,
      });
    });
  });
});
