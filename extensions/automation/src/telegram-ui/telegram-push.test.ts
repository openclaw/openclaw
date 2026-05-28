import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMessage, resetBotTokenCache } from "./telegram-push.js";

const mockApi = {} as OpenClawPluginApi;

describe("telegram push editMessage not-modified guard", () => {
  beforeEach(() => {
    resetBotTokenCache();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:tok");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetBotTokenCache();
  });

  it("treats ANSI-decorated not-modified response as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "\u001b[31mBad Request: message is not modified\u001b[0m",
      })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await editMessage(mockApi, {
      chatId: "123",
      messageId: 88,
      text: "same content",
    });

    expect(ok).toBe(true);
  });

  it("treats escaped-newline not-modified payload as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: false,
          description: "Bad Request: message is\\nnot modified",
        }),
      })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await editMessage(mockApi, {
      chatId: "123",
      messageId: 88,
      text: "same content",
    });

    expect(ok).toBe(true);
  });

  it("returns false when editMessageText fails for other reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = await editMessage(mockApi, {
      chatId: "123",
      messageId: 88,
      text: "update",
    });

    expect(ok).toBe(false);
  });

  it("sanitizes zero-width button labels before editing message", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await editMessage(mockApi, {
      chatId: "123",
      messageId: 88,
      text: "update",
      buttons: [
        [
          { text: "\u200B\u200D刷新\uFEFF", callback_data: "sc:refresh" },
          { text: "\u200B\u200D\uFEFF", callback_data: "sc:fallback" },
        ],
      ],
    });

    expect(ok).toBe(true);
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(String(rawBody)) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> };
    };
    expect(body.reply_markup?.inline_keyboard?.[0]).toEqual([
      { text: "刷新", callback_data: "sc:refresh" },
      { text: "操作", callback_data: "sc:fallback" },
    ]);
  });
});
