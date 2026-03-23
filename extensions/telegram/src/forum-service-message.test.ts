import { describe, expect, it } from "vitest";
import {
  isTelegramForumServiceMessage,
  TELEGRAM_FORUM_SERVICE_FIELDS,
} from "./forum-service-message.js";

describe("isTelegramForumServiceMessage", () => {
  it("returns true for any Telegram forum service field", () => {
    for (const field of TELEGRAM_FORUM_SERVICE_FIELDS) {
      expect(isTelegramForumServiceMessage({ [field]: {} })).toBe(true);
    }
  });

  it("returns false for normal messages and non-objects", () => {
    expect(isTelegramForumServiceMessage({ text: "hello" })).toBe(false);
    expect(isTelegramForumServiceMessage(null)).toBe(false);
    expect(isTelegramForumServiceMessage("topic created")).toBe(false);
  });
});
