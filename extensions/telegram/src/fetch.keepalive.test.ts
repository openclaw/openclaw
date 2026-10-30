import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { PROXY_FIXTURE_HOST, withProxyFixture, withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isSafeToRetrySendError } from "./network-errors.js";

beforeEach(() => {
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
afterEach(() => vi.unstubAllEnvs());

async function withApi(apiRoot: string, run: (api: Api) => Promise<void>) {
  const transport = resolveTelegramTransport();
  const fetch = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(transport.fetch),
    transport,
  });
  if (!fetch) {
    throw new Error("missing Telegram fetch");
  }
  try {
    await run(new Api("123456:fixture-token", { apiRoot, fetch: asTelegramClientFetch(fetch) }));
  } finally {
    await transport.close();
  }
}

it("rich sends avoid the idle socket retired as a reply starts, without disabling control pooling", async () => {
  const method = "sendRichMessage";
  const controls: Socket[] = [];
  const sends: Socket[] = [];
  let retired = false;
  const headers = channel("undici:client:sendHeaders");
  const retireIdle = (event: unknown) => {
    const { request } = event as { request: { path: string } };
    if (request.path.endsWith("/" + method) && !retired) {
      retired = true;
      controls[0]?.resetAndDestroy();
    }
  };
  await withServer(
    (request, response) => {
      request.resume();
      request.on("end", () => {
        const sending = request.url?.endsWith("/" + method);
        (sending ? sends : controls).push(request.socket);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            result: sending
              ? { message_id: sends.length, chat: { id: 1, type: "private" } }
              : { id: 123456, is_bot: true, first_name: "Fixture" },
          }),
        );
      });
    },
    async (apiRoot) => {
      await withApi(apiRoot, async (api) => {
        await api.getMe();
        // Let Undici publish its idle pool state before racing the next request.
        await setImmediate();
        await api.getMe();
        await setImmediate();
        expect(controls[0]).toBe(controls[1]);
        headers.subscribe(retireIdle);
        try {
          const send = () => api.raw.sendRichMessage({ chat_id: 1, rich_message: { blocks: [] } });
          await expect(send()).resolves.toMatchObject({ message_id: 1 });
          await expect(send()).resolves.toMatchObject({ message_id: 2 });
          expect(retired).toBe(true);
          expect(sends).toHaveLength(2);
          expect(sends[0]).not.toBe(controls[0]);
          expect(sends[1]).not.toBe(sends[0]);
        } finally {
          headers.unsubscribe(retireIdle);
        }
      });
    },
  );
});

it.each(["close", "body"] as const)(
  "does not replay an accepted send when the response is lost through %s",
  async (failure) => {
    let accepted = 0;
    await withServer(
      (request, response) => {
        request.resume();
        request.on("end", () => {
          accepted += 1;
          if (failure === "body") {
            response.writeHead(200, {
              "content-type": "application/json",
              "content-length": "500",
            });
            response.write('{"ok":true,"result":');
            void setImmediate().then(() => request.socket.resetAndDestroy());
          } else {
            request.socket.end();
          }
        });
      },
      async (apiRoot) => {
        await withApi(apiRoot, async (api) => {
          const error = await api.sendMessage(1, "Accepted before the response was lost").then(
            () => {
              throw new Error("expected transport failure");
            },
            (caught: unknown) => caught,
          );
          expect(isSafeToRetrySendError(error)).toBe(false);
          expect(accepted).toBe(1);
        });
      },
    );
  },
);

it("downloads distinct concurrent attachments, cancels an in-flight body, and recovers through SOCKS", async () => {
  await withOpenClawTestState({ label: "telegram-socks-media" }, async () => {
    await withProxyFixture(async ({ socksProxy, waitForSocketsClosed }) => {
      const token = "12345:fixture-token";
      const apiRoot = `http://${PROXY_FIXTURE_HOST}`;
      const transport = resolveTelegramTransport(makeProxyFetch(socksProxy));
      const bodyReady = createDeferred<void>();
      const sourceFetch = transport.sourceFetch;
      transport.sourceFetch = async (input, init) => {
        const response = await sourceFetch(input, init);
        if (typeof input === "string" && input.endsWith("/stall")) {
          bodyReady.resolve();
        }
        return response;
      };
      const clientFetch = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(transport.fetch),
        transport,
      });
      assert(clientFetch);
      const api = new Api(token, { apiRoot, fetch: asTelegramClientFetch(clientFetch) });
      const contextFor = (fileId: string): TelegramContext => ({
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private", first_name: "Fixture" },
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: `${fileId}.txt`,
          },
        },
        getFile: (signal) => api.getFile(fileId, signal),
      });
      const download = (fileId: string, abortSignal?: AbortSignal) =>
        resolveMedia({
          ctx: contextFor(fileId),
          token,
          transport,
          apiRoot,
          maxBytes: 1_024,
          abortSignal,
        });
      try {
        await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const fileId = `attachment-${index}`;
            const media = await download(fileId);
            assert(media);
            expect(media.fileName).toBe(`${fileId}.txt`);
            expect(await readFile(media.path, "utf8")).toBe(fileId);
          }),
        );
        const controller = new AbortController();
        const rejected = expect(
          download("stall", AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])),
        ).rejects.toThrow(/aborted|cancelled/i);
        await Promise.race([
          bodyReady.promise,
          rejected.then(() => {
            throw new Error("download ended before response headers");
          }),
        ]);
        controller.abort(new Error("fixture media cancelled"));
        await rejected;
        const recovered = await download("recovered");
        assert(recovered);
        expect(await readFile(recovered.path, "utf8")).toBe("recovered");
      } finally {
        await transport.close();
      }
      await waitForSocketsClosed();
    });
  });
});
