import { describe, expect, it } from "vitest";
import { buildInlineKeyboard } from "./inline-keyboard.js";

describe("buildInlineKeyboard", () => {
  it("builds callback, URL, and Mini App buttons", () => {
    expect(
      buildInlineKeyboard([
        [
          { text: "Approve", callback_data: "approve", style: "success" },
          { text: "Docs", url: "https://example.com/docs" },
          { text: "Canvas", web_app: { url: "https://example.com/canvas" } },
        ],
      ]),
    ).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: "approve", style: "success" },
          { text: "Docs", url: "https://example.com/docs" },
          { text: "Canvas", web_app: { url: "https://example.com/canvas" } },
        ],
      ],
    });
  });
});
