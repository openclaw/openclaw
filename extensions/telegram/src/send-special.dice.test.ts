// Telegram tests cover sendDice outbound behavior over the real Bot API transport.
import { describe, expect, it } from "vitest";
import { sendDiceTelegram } from "./send-special.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("sendDiceTelegram", () => {
  const fixture = useTelegramHttpFixture();
  const roll =
    (emoji: string, value: number) => (method: string, fields: Record<string, unknown>) =>
      method === "sendDice"
        ? { message_id: 200, chat: { id: fields.chat_id }, dice: { emoji, value } }
        : undefined;

  it("defaults to the plain die and reports the value Telegram rolled", async () => {
    // The face is decided server-side, so the sender must read the roll back instead of
    // echoing its own input, and an omitted emoji must still reach the API as a valid face.
    fixture.responseFor = roll("\u{1F3B2}", 4);

    const res = await sendDiceTelegram("123", undefined, {
      cfg: fixture.cfg,
      api: fixture.bot.api,
    });

    expect(fixture.requests.at(-1)).toMatchObject({
      method: "sendDice",
      fields: { chat_id: "123", emoji: "\u{1F3B2}" },
    });
    expect(res).toMatchObject({ messageId: "200", chatId: "123", emoji: "\u{1F3B2}", value: 4 });
  });

  it.each(["\u{1F3B2}", "\u{1F3AF}", "\u{1F3C0}", "\u{26BD}", "\u{1F3B3}", "\u{1F3B0}"])(
    "passes the %s face through",
    async (emoji) => {
      fixture.responseFor = roll(emoji, 6);

      const res = await sendDiceTelegram("123", emoji, { cfg: fixture.cfg, api: fixture.bot.api });

      expect(fixture.requests.at(-1)?.fields).toMatchObject({ emoji });
      expect(res).toMatchObject({ emoji, value: 6 });
    },
  );

  it("accepts a face carrying the emoji presentation selector", async () => {
    // Clients often append U+FE0F; Telegram rejects the decorated form, so it is normalized here.
    fixture.responseFor = roll("\u{26BD}", 3);

    await sendDiceTelegram("123", "\u{26BD}️", { cfg: fixture.cfg, api: fixture.bot.api });

    expect(fixture.requests.at(-1)?.fields).toMatchObject({ emoji: "\u{26BD}" });
  });

  it("rejects an unsupported emoji before reaching the API", async () => {
    const before = fixture.requests.length;

    await expect(
      sendDiceTelegram("123", "\u{1F388}", { cfg: fixture.cfg, api: fixture.bot.api }),
    ).rejects.toThrow(/Unsupported Telegram dice emoji/u);

    expect(fixture.requests).toHaveLength(before);
  });

  it("records the send boundary and refuses a revoked handoff before rolling", async () => {
    // Target preparation is awaited, so custody can be revoked while it runs. The roll must be
    // recorded at the dispatch boundary and re-checked immediately before the API side effect,
    // exactly like the poll sender next to it.
    fixture.responseFor = roll("\u{1F3B2}", 2);
    const order: string[] = [];

    await sendDiceTelegram("123", "\u{1F3B2}", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
      assertPlatformSendAuthorized: () => {
        order.push("authorized");
      },
    });

    expect(order).toEqual(["dispatch", "authorized"]);

    const before = fixture.requests.length;
    await expect(
      sendDiceTelegram("123", "\u{1F3B2}", {
        cfg: fixture.cfg,
        api: fixture.bot.api,
        assertPlatformSendAuthorized: () => {
          throw new Error("handoff revoked");
        },
      }),
    ).rejects.toThrow("handoff revoked");
    expect(fixture.requests).toHaveLength(before);
  });

  it("omits the value when Telegram returns no dice payload", async () => {
    // A roll without its payload is still a delivered message; inventing a value would report
    // a result nobody rolled.
    fixture.responseFor = (method, fields) =>
      method === "sendDice" ? { message_id: 202, chat: { id: fields.chat_id } } : undefined;

    const res = await sendDiceTelegram("123", "\u{1F3B2}", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
    });

    expect(res.value).toBeUndefined();
  });
});
