import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  botCtorSpy,
} from "./bot.create-telegram-bot.test-harness.js";

const noteNetworkHealthySpy = vi.fn();

vi.mock("./sendchataction-401-backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sendchataction-401-backoff.js")>();
  return {
    ...actual,
    createTelegramSendChatActionHandler: vi.fn(() => ({
      sendChatAction: vi.fn(async () => {}),
      isSuspended: () => false,
      noteNetworkHealthy: noteNetworkHealthySpy,
      reset: vi.fn(),
    })),
  };
});

const { createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot.js");
setTelegramBotRuntimeForTest(
  telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
);
const createTelegramBot = (opts: Parameters<typeof createTelegramBotBase>[0]) =>
  createTelegramBotBase({
    ...opts,
    telegramDeps: telegramBotDepsForTest,
  });

function getClientFetch(): typeof fetch {
  const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: typeof fetch } })
    ?.client?.fetch;
  if (!clientFetch) {
    throw new Error("Missing Telegram client fetch");
  }
  return clientFetch;
}

describe("createTelegramBot network-health fetch wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks Telegram JSON 4xx responses as network-healthy", async () => {
    const baseFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests" }),
        {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }) as typeof fetch;

    createTelegramBot({
      token: "tok",
      telegramTransport: { fetch: baseFetch } as Parameters<
        typeof createTelegramBot
      >[0]["telegramTransport"],
    });

    const clientFetch = getClientFetch();
    const response = await clientFetch("https://api.telegram.org/bot123/sendMessage");

    expect(response.status).toBe(429);
    expect(noteNetworkHealthySpy).toHaveBeenCalledTimes(1);
  });

  it("marks Telegram JSON 5xx responses as network-healthy", async () => {
    const baseFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: 500, description: "Internal Server Error" }),
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }) as typeof fetch;

    createTelegramBot({
      token: "tok",
      telegramTransport: { fetch: baseFetch } as Parameters<
        typeof createTelegramBot
      >[0]["telegramTransport"],
    });

    const clientFetch = getClientFetch();
    const response = await clientFetch("https://api.telegram.org/bot123/sendMessage");

    expect(response.status).toBe(500);
    expect(noteNetworkHealthySpy).toHaveBeenCalledTimes(1);
  });

  it("does not treat proxy-generated 407 responses as Telegram health", async () => {
    const baseFetch = vi.fn(async () => {
      return new Response("Proxy Authentication Required", {
        status: 407,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }) as typeof fetch;

    createTelegramBot({
      token: "tok",
      telegramTransport: { fetch: baseFetch } as Parameters<
        typeof createTelegramBot
      >[0]["telegramTransport"],
    });

    const clientFetch = getClientFetch();
    const response = await clientFetch("https://api.telegram.org/bot123/sendMessage");

    expect(response.status).toBe(407);
    expect(noteNetworkHealthySpy).not.toHaveBeenCalled();
  });
});
