import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { Api } from "grammy";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it.each(["sendMessage", "sendRichMessage"] as const)(
  "%s avoids the idle socket retired as a terminal reply starts, without disabling control pooling",
  async (method) => {
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
            const send = () =>
              method === "sendMessage"
                ? api.sendMessage(1, "Something went wrong. Please try again.")
                : api.raw.sendRichMessage({ chat_id: 1, rich_message: { blocks: [] } });
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
  },
);

it.each(["reset", "close", "body"] as const)(
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
          } else if (failure === "reset") {
            request.socket.resetAndDestroy();
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
