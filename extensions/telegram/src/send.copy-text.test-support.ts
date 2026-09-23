import { describe, expect, it } from "vitest";
import { importTelegramSendModule, installTelegramSendTestHooks } from "./send.test-harness.js";

installTelegramSendTestHooks();

const { buildInlineKeyboard } = await importTelegramSendModule();

describe("buildInlineKeyboard copy-text support", () => {
  it("keeps copy text buttons", () => {
    expect(buildInlineKeyboard([[{ text: "Copy", copy_text: { text: "TOKEN-7319" } }]])).toEqual({
      inline_keyboard: [[{ text: "Copy", copy_text: { text: "TOKEN-7319" } }]],
    });
  });
});
