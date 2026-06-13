import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  // The vi.mock factory needs Bot exported as a constructible value, but the
  // test only ever uses Bot as a type (`as unknown as Bot`) so the runtime
  // shape is intentionally empty.
  // oxlint-disable-next-line no-extraneous-class
  Bot: class Bot {},
  HttpError: class HttpError extends Error {},
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

function createBot(sendMessage: ReturnType<typeof vi.fn>): Bot {
  return { api: { sendMessage } } as unknown as Bot;
}

// The "interrupted mid-reply turn" delivery shape: the model emits an HTML chunk
// that trims locally to empty (whitespace-only, empty inline tags such as <i></i>)
// and the delivery contract passes plainText="" because no human-visible source
// text was produced. Before this fix, the resulting Telegram 400 surfaced as a
// delivery failure; after the fix, the send is silently skipped.
//
// Note on cases that are NOT empty-text skips and are intentionally absent here:
// - Bare <br>, <br/>, <br /> reach Telegram as a parse error ("can't parse
//   entities: unsupported start tag"), not the empty-text 400, so they take a
//   different recovery path and are not part of the silent-skip contract.
// - &nbsp; payloads round-trip to Telegram as the Unicode NBSP character (U+00A0),
//   which is a successful delivery, not a skip.
// Restricting the fixture to truly empty-after-trim payloads keeps future
// maintenance pointed at the correct Telegram contract (ClawSweeper P3 finding
// on #88810).
const EMPTY_HTML_PAYLOADS = [
  { label: "empty string after trim", htmlText: "   ", expectedApiCalls: 0 },
];

describe("sendTelegramText empty-text silent skip", () => {
  for (const { label, htmlText, expectedApiCalls } of EMPTY_HTML_PAYLOADS) {
    it(`silently skips html ${label} when Telegram rejects as empty and no plain fallback`, async () => {
      // Locally-empty payloads must short-circuit pre-flight (no API call) so
      // they cannot bubble a 400 up to the delivery caller.
      const runtime = createRuntime();
      const sendMessage = vi.fn(async () => {
        throw new Error("400: Bad Request: message text is empty");
      });
      const bot = createBot(sendMessage);

      const result = await sendTelegramText(bot, "123", htmlText, runtime as RuntimeEnv, {
        textMode: "html",
        plainText: "",
      });

      expect(result).toBeUndefined();
      // expectedApiCalls=0 means the pre-flight trim-empty branch short-circuits
      // before any API call; expectedApiCalls=1 means the HTML send tries once,
      // Telegram returns the 400, and the catch-side silent-skip handles it.
      expect(sendMessage).toHaveBeenCalledTimes(expectedApiCalls);
    });
  }

  it("silently skips before any API call when html and plain fallback are both whitespace-only", async () => {
    // Pre-flight skip: trim of the formatted HTML and trim of the plain fallback are
    // both empty, so the no-op short-circuits before sendMessage is invoked.
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "   ", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "   \n\t  ",
    });

    expect(result).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently skips when Telegram rejects post-strip text with the newer 'text must be non-empty' wording", async () => {
    // Bot API variant observed alongside the legacy "message text is empty" wording.
    // The regex must catch both or this 400 escapes back to the delivery caller as
    // a hard failure that retries forever and pollutes the error log.
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: text must be non-empty");
    });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "<i></i>", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "",
    });

    expect(result).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still throws for unrelated send failures", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: chat not found");
    });
    const bot = createBot(sendMessage);

    await expect(
      sendTelegramText(bot, "123", "hello", runtime as RuntimeEnv, { textMode: "html" }),
    ).rejects.toThrow(/chat not found/);
  });

  it("still delivers when the formatted payload contains real content", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42, chat: { id: "123" } });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "hello world", runtime as RuntimeEnv, {
      textMode: "markdown",
    });

    expect(result).toBe(42);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
