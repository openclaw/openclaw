// Telegram tests cover the empty-text silent-skip contract of sendTelegramText.
import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  InputFile: class InputFile {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

const { sendTelegramText } = await import("./delivery.send.js");

type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

function createRuntime(): RuntimeStub {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
  };
}

function createBot(api: Record<string, unknown>): Bot {
  return { api: { ...api, raw: api.raw ?? {} } } as unknown as Bot;
}

// The "interrupted mid-reply turn" shape: the model emits HTML that carries no
// visible text (e.g. `<i></i>`) and the delivery contract passes plainText=""
// because no human-visible source text exists. Telegram rejects such payloads
// with a 400; the silent-skip contract turns that into a no-op instead of a
// user-visible delivery failure. Parse errors stay out of scope and throw.
describe("sendTelegramText empty-text silent skip", () => {
  const emptyTextWordings = [
    "400: Bad Request: message text is empty",
    "400: Bad Request: text must be non-empty",
  ];

  for (const wording of emptyTextWordings) {
    it(`skips silently when Telegram rejects html with "${wording}" and no plain fallback`, async () => {
      const runtime = createRuntime();
      const sendMessage = vi.fn(async () => {
        throw new Error(wording);
      });
      const bot = createBot({ sendMessage });

      const result = await sendTelegramText(bot, "123", "<i></i>", runtime as RuntimeEnv, {
        textMode: "html",
        plainText: "",
      });

      expect(result).toBeUndefined();
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  }

  it("skips before any API call when formatted text and plain fallback both trim empty", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage });

    const result = await sendTelegramText(bot, "123", "   ", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "",
    });

    expect(result).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still recovers via plain fallback when the empty-text 400 has fallback text", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: text must be non-empty"))
      .mockResolvedValueOnce({ message_id: 7, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    const result = await sendTelegramText(bot, "123", "<i></i>", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "visible fallback",
    });

    expect(result).toBe(7);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.at(1)?.[1]).toBe("visible fallback");
  });

  it("still throws parse errors when there is no plain fallback", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error('400: Bad Request: can\'t parse entities: Unsupported start tag "br"');
    });
    const bot = createBot({ sendMessage });

    await expect(
      sendTelegramText(bot, "123", "<br>", runtime as RuntimeEnv, {
        textMode: "html",
        plainText: "",
      }),
    ).rejects.toThrow(/can't parse entities/);
  });

  it("still throws unrelated send failures", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: chat not found");
    });
    const bot = createBot({ sendMessage });

    await expect(
      sendTelegramText(bot, "123", "hello", runtime as RuntimeEnv, { textMode: "html" }),
    ).rejects.toThrow(/chat not found/);
  });

  it("still delivers real content and resolves the Telegram message id", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    const result = await sendTelegramText(bot, "123", "hello world", runtime as RuntimeEnv, {
      textMode: "markdown",
    });

    expect(result).toBe(42);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("skips rich sends that render empty when the plain fallback is also empty", async () => {
    const runtime = createRuntime();
    const sendRichMessage = vi.fn();
    const bot = createBot({ raw: { sendRichMessage } });

    const result = await sendTelegramText(bot, "123", "   ", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "",
      richMessages: true,
    });

    expect(result).toBeUndefined();
    expect(sendRichMessage).not.toHaveBeenCalled();
  });

  it("skips silently when the rich lane rejects content as empty and no plain fallback exists", async () => {
    const runtime = createRuntime();
    // Telegram is authoritative on visible emptiness: a locally non-empty rich
    // plan can still come back RICH_MESSAGE_CONTENT_REQUIRED server-side.
    const sendRichMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: RICH_MESSAGE_CONTENT_REQUIRED");
    });
    const bot = createBot({ raw: { sendRichMessage } });

    const result = await sendTelegramText(
      bot,
      "123",
      "invisible-to-telegram",
      runtime as RuntimeEnv,
      {
        textMode: "markdown",
        plainText: "",
        richMessages: true,
      },
    );

    expect(result).toBeUndefined();
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
  });
});
