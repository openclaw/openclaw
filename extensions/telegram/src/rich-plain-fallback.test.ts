import { describe, expect, it, vi } from "vitest";
import { isTelegramEmptyContentError, withTelegramPlainFallback } from "./rich-plain-fallback.js";

// message, rich fallback, HTML fallback
const fallbackCases = [
  ["Bad Request: RICH_MESSAGE_URL_INVALID", "rich-entity-invalid", undefined],
  ["Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY", "rich-structure-invalid", undefined],
  ["Bad Request: RICH_MESSAGE_CONTENT_REQUIRED", "rich-content-required", "empty-content"],
  ["Bad Request: rich message must be non-empty", "rich-content-required", "empty-content"],
  ["Bad Request: can't parse entities: unsupported tag", "html-parse", "html-parse"],
  ["Bad Request: message text is empty", undefined, "empty-content"],
  ["read ECONNRESET", undefined, undefined],
] as const;

function attempt(kind: "rich" | "html", message: string, plainText: string, limit?: number) {
  const error = new Error(message);
  const warn = vi.fn();
  const sendFormatted = vi.fn(async () => {
    throw error;
  });
  const sendPlain = vi.fn(async () => "plain");
  const run = withTelegramPlainFallback({
    kind,
    context: "test send",
    plainText,
    limit,
    warn,
    sendFormatted,
    sendPlain,
  });
  return { error, warn, sendFormatted, sendPlain, run };
}

describe("withTelegramPlainFallback", () => {
  it.each(
    (["rich", "html"] as const).flatMap((kind) =>
      fallbackCases.map(([message, richTrigger, htmlTrigger]) => ({
        kind,
        message,
        richTrigger,
        htmlTrigger,
      })),
    ),
  )("classifies $kind $message consistently", async (testCase) => {
    const { error, warn, sendFormatted, sendPlain, run } = attempt(
      testCase.kind,
      testCase.message,
      "fallback body",
      8,
    );
    const trigger = testCase.kind === "rich" ? testCase.richTrigger : testCase.htmlTrigger;
    expect(sendFormatted).toHaveBeenCalledTimes(1);

    if (!trigger) {
      await expect(run).rejects.toBe(error);
      expect(sendPlain).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      return;
    }

    await expect(run).resolves.toBe("plain");
    expect(sendPlain).toHaveBeenCalledWith(
      { plainText: "fallback body", chunks: ["fallback", " body"] },
      "test send-plain",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `telegram test send degrade=plain-fallback:${trigger}: ${testCase.message}`,
    );
  });

  it.each([
    { kind: "rich" as const, message: "Bad Request: RICH_MESSAGE_URL_INVALID" },
    { kind: "rich" as const, message: "Bad Request: rich message must be non-empty" },
    { kind: "html" as const, message: "Bad Request: message text is empty" },
  ])("rethrows $kind failures when plain text is empty", async ({ kind, message }) => {
    const { error, warn, sendPlain, run } = attempt(kind, message, " \n");
    await expect(run).rejects.toBe(error);
    expect(sendPlain).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("isTelegramEmptyContentError", () => {
  it.each([
    "Bad Request: message text is empty",
    "Bad Request: text must be non-empty",
    "Bad Request: RICH_MESSAGE_CONTENT_REQUIRED",
    "Bad Request: rich message must be non-empty",
  ])("recognizes %s", (message) => {
    expect(isTelegramEmptyContentError(new Error(message))).toBe(true);
  });

  it("does not hide unrelated bad requests", () => {
    expect(isTelegramEmptyContentError(new Error("Bad Request: content rejected"))).toBe(false);
  });
});
