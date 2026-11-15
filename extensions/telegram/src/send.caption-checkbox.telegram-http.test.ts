import { describe, expect, it } from "vitest";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram caption checkbox types over HTTP", () => {
  const fixture = useTelegramHttpFixture();

  it.each([
    { textMode: "html", inputType: "CHECKBOX" },
    { textMode: "markdown", inputType: "CheckBox" },
  ] as const)(
    "renders $inputType checkboxes in $textMode media captions",
    async ({ textMode, inputType }) => {
      await sendMessageTelegram(
        "123",
        `<ul><li><input type="${inputType}" checked/>Done</li></ul>`,
        {
          cfg: fixture.cfg,
          api: fixture.bot.api,
          mediaUrl: fixture.photoPath,
          mediaLocalRoots: [fixture.mediaDir],
          textMode,
        },
      );

      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        method: "sendPhoto",
        fields: { parse_mode: "HTML", caption: "[x] Done" },
      });
    },
  );
});
