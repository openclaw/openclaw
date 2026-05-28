import { describe, expect, it } from "vitest";
import { buildInteractiveErrorHtml, classifyInteractiveError } from "./error-format.js";

describe("automation telegram interactive error format", () => {
  it("classifies command-not-found errors", () => {
    const info = classifyInteractiveError(
      "The command pnpm autonomous:controlled:next-safe was not found",
    );
    expect(info.code).toBe("CMD_NOT_FOUND");
    expect(info.summary).toContain("命令不存在");
  });

  it("classifies timeout errors", () => {
    const info = classifyInteractiveError("request timed out after 30s");
    expect(info.code).toBe("TIMEOUT");
  });

  it("classifies Telegram not-modified message as up-to-date info", () => {
    const info = classifyInteractiveError(
      "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
    );
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(
      "Call to 'editMessageText' failed! (400: Bad Request: message is not modified)",
    );
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("classifies up-to-date when not-modified only appears in object toString payload", () => {
    const raw = {
      message: "Call to 'editMessageText' failed!",
      toString() {
        return (
          "Call to 'editMessageText' failed! " +
          "(400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)"
        );
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("classifies up-to-date when Error.message is generic but toString carries not-modified", () => {
    class TelegramEditNoopError extends Error {
      override toString() {
        return (
          "Call to 'editMessageText' failed! " +
          "(400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)"
        );
      }
    }
    const raw = new TelegramEditNoopError("Call to 'editMessageText' failed!");
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("classifies up-to-date when not-modified only appears in Error.stack", () => {
    const raw = new Error("Call to 'editMessageText' failed!");
    Object.defineProperty(raw, "stack", {
      value:
        "Error: Call to 'editMessageText' failed!\n" +
        "    at callback-router.ts:1:1\n" +
        "Caused by: 400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      configurable: true,
    });
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("still classifies up-to-date when not-modified token appears after 240 chars", () => {
    const longPrefix = "x".repeat(300);
    const info = classifyInteractiveError(
      `${longPrefix} Call to 'editMessageText' failed! (400: Bad Request: message is not modified)`,
    );
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date when message-is-not-modified contains line breaks", () => {
    const info = classifyInteractiveError(
      "Call to 'editMessageText' failed! (400: Bad Request: message is\nnot modified)",
    );
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date when not-modified token includes zero-width separators", () => {
    const info = classifyInteractiveError(
      "Call to 'editMessageText' failed! (400: Bad Request: message\u200Bis\u200Bnot\u200Bmodified)",
    );
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date when not-modified token includes ANSI color codes", () => {
    const info = classifyInteractiveError(
      "Call to 'editMessageText' failed! (400: Bad Request: \u001b[31mmessage is not modified\u001b[0m)",
    );
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date for nested Telegram error object with escaped newline", () => {
    const info = classifyInteractiveError({
      error: {
        description:
          "Call to 'editMessageText' failed! (400: Bad Request: message is\\nnot modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
      },
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date for double-escaped not-modified text from JSON payloads", () => {
    const info = classifyInteractiveError({
      detail:
        "Call to 'editMessageText' failed! (400: Bad Request: message is\\\\nnot modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)",
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date for cause.description payload with escaped newline", () => {
    const info = classifyInteractiveError({
      cause: {
        description: "Bad Request: message is\\nnot modified",
      },
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date for cause.message payload with escaped newline", () => {
    const info = classifyInteractiveError({
      cause: {
        message: "Bad Request: message is\\nnot modified",
      },
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("classifies up-to-date for cause.message payload with double-escaped newline", () => {
    const info = classifyInteractiveError({
      cause: {
        message: "Bad Request: message is\\\\nnot modified",
      },
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("renders up-to-date html for double-escaped not-modified payload", () => {
    const raw = {
      cause: {
        message: "Bad Request: message is\\\\nnot modified",
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("classifies up-to-date for cause.description payload with double-escaped newline", () => {
    const info = classifyInteractiveError({
      cause: {
        description: "Bad Request: message is\\\\nnot modified",
      },
    });
    expect(info.code).toBe("UP_TO_DATE");
  });

  it("renders up-to-date html for cause.description payload with literal newline", () => {
    const raw = {
      cause: {
        description: "Bad Request: message is\nnot modified",
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("renders up-to-date html for cause.message payload with literal newline", () => {
    const raw = {
      cause: {
        message: "Bad Request: message is\nnot modified",
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("renders up-to-date html for response.description payload with literal newline", () => {
    const raw = {
      response: {
        description: "Bad Request: message is\nnot modified",
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("renders up-to-date html for response.description payload with double-escaped newline", () => {
    const raw = {
      response: {
        description: "Bad Request: message is\\\\nnot modified",
      },
    };
    const info = classifyInteractiveError(raw);
    expect(info.code).toBe("UP_TO_DATE");
    const html = buildInteractiveErrorHtml(raw);
    expect(html).toContain("畫面已是最新狀態");
    expect(html).not.toContain("❌ <b>操作失敗</b>");
  });

  it("escapes html in details", () => {
    const html = buildInteractiveErrorHtml("<bad>tag</bad>");
    expect(html).toContain("&lt;bad&gt;tag&lt;/bad&gt;");
  });

  it("renders UNKNOWN code with Chinese label while preserving canonical code", () => {
    const html = buildInteractiveErrorHtml("unexpected boom");
    expect(html).toContain("錯誤代碼");
    expect(html).toContain("未知錯誤 (UNKNOWN)");
  });
});
