import { describe, expect, it } from "vitest";
import { formatTelegramDebounceFlushError } from "./bot-handlers.runtime.js";

describe("formatTelegramDebounceFlushError", () => {
  it("includes stack details when Telegram debounce processing fails", () => {
    const error = new Error("debounce boom");
    error.stack = "Error: debounce boom\n    at processTelegramMessage";

    expect(formatTelegramDebounceFlushError(error)).toContain("processTelegramMessage");
  });

  it("formats non-error thrown values", () => {
    expect(formatTelegramDebounceFlushError("plain failure")).toBe("plain failure");
  });
});
