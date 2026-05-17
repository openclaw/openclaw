import { describe, expect, it } from "vitest";
import { stringifyTelegramRawUpdateForLog } from "./raw-update-log.js";

describe("stringifyTelegramRawUpdateForLog", () => {
  it("redacts private Telegram raw update fields before verbose logging", () => {
    const update = {
      update_id: 98765,
      message: {
        message_id: 44,
        from: {
          id: 123456,
          is_bot: false,
          first_name: "Alice",
          last_name: "Example",
          username: "alice_private",
        },
        chat: {
          id: -1001234567890,
          type: "private",
          title: "Private Chat",
          username: "private_chat",
        },
        text: "please inspect https://private.example/secret",
        entities: [{ type: "url", offset: 15, length: 30, url: "https://private.example/entity" }],
        link_preview_options: { url: "https://private.example/preview" },
      },
      callback_query: {
        id: "callback-id",
        from: { id: 7777, first_name: "Bob", username: "bob_private" },
        data: "sensitive callback payload",
      },
    };

    const rawLog = stringifyTelegramRawUpdateForLog(update);

    expect(rawLog).toContain('"update_id":98765');
    expect(rawLog).toContain('"message_id":44');
    expect(rawLog).toContain('"text":"[redacted]"');
    expect(rawLog).toContain('"url":"[redacted]"');
    for (const privateValue of [
      "123456",
      "-1001234567890",
      "Alice",
      "Example",
      "alice_private",
      "Private Chat",
      "private_chat",
      "please inspect",
      "https://private.example",
      "7777",
      "Bob",
      "bob_private",
      "sensitive callback payload",
    ]) {
      expect(rawLog).not.toContain(privateValue);
    }
  });
});
