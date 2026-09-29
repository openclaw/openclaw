import { resetGlobalHookRunner } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram edit recovery over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, rejections } = fixture;
  let bot: typeof fixture.bot;
  beforeEach(() => {
    ({ bot } = fixture);
  });
  afterEach(() => {
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });

  it.each([
    {
      rich: false,
      rejection: "Bad Request: message is not modified",
      methods: ["editMessageText"],
      texts: ["<b>visible</b>"],
    },
    {
      rich: false,
      rejection: "Bad Request: message text is empty",
      methods: ["editMessageText", "editMessageText"],
      texts: ["<b>visible</b>", "visible"],
    },
    {
      rich: false,
      rejection: "Bad Request: there is no text in the message to edit",
      methods: ["editMessageText", "editMessageCaption"],
      texts: ["<b>visible</b>", "<b>visible</b>"],
    },
    {
      rich: true,
      rejection: "Bad Request: RICH_MESSAGE_URL_INVALID",
      methods: ["editMessageText", "editMessageText"],
      texts: [undefined, "visible"],
    },
  ])(
    "recovers an existing message after $rejection without creating another",
    async ({ rich, rejection, methods, texts }) => {
      rejections.push(rejection);
      await editMessageTelegram("123", 321, rich ? "**visible**" : "<b>visible</b>", {
        cfg: {
          channels: {
            telegram: { ...cfg.channels.telegram, richMessages: rich, linkPreview: false },
          },
        },
        api: bot.api,
        textMode: rich ? "markdown" : "html",
        editMode: "auto",
        buttons: [],
      });
      expect(requests.map(({ method }) => method)).toEqual(methods);
      expect(requests.map(({ fields }) => fields.text ?? fields.caption)).toEqual(texts);
      for (const { fields } of requests) {
        expect(fields.message_id).toBe(321);
        expect(fields.reply_markup).toEqual({ inline_keyboard: [] });
      }
    },
  );

  it.each([
    { count: 500, list: false, rejected: false },
    { count: 501, list: false, rejected: true },
    { count: 251, list: true, rejected: true },
  ])(
    "keeps every item in a $count-block rich edit (list: $list)",
    async ({ count, list, rejected }) => {
      const tokens = Array.from(
        { length: count },
        (_, index) => `P${String(index).padStart(3, "0")}`,
      );
      const text = tokens.map((token) => `${list ? "- " : ""}${token}`).join(list ? "\n" : "\n\n");
      if (rejected) {
        rejections.push("Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY");
      }
      await editMessageTelegram("123", 321, text, {
        cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
        api: bot.api,
      });
      expect(requests.map(({ method }) => method)).toEqual(
        Array(rejected ? 2 : 1).fill("editMessageText"),
      );
      expect(JSON.stringify(requests.at(-1)!.fields).match(/P\d{3}/g)).toEqual(tokens);
      expect(requests.every(({ fields }) => fields.reply_markup === undefined)).toBe(true);
    },
  );

  it.each([undefined, true, false])(
    "resolves named-account edit previews with explicit override %s",
    async (linkPreview) => {
      rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
      await editMessageTelegram("123", 321, "**Read** https://example.com", {
        cfg: {
          channels: {
            telegram: {
              ...cfg.channels.telegram,
              richMessages: true,
              linkPreview: true,
              accounts: { worker: { linkPreview: false } },
            },
          },
        },
        accountId: "worker",
        token: cfg.channels.telegram.botToken,
        api: bot.api,
        linkPreview,
      });
      expect(requests.map(({ fields }) => fields.link_preview_options)).toEqual(
        Array(2).fill(linkPreview === true ? undefined : { is_disabled: true }),
      );
    },
  );

  it("keeps styled HTML link labels on rich edit fallback and rejects oversized replacement atomically", async () => {
    const richCfg = { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } };
    rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
    await editMessageTelegram(
      "123",
      321,
      '<details><summary>More</summary><p><a href="https://example.com">**Download**</a></p></details>',
      { cfg: richCfg, api: bot.api },
    );
    expect(JSON.stringify(requests[0]!.fields.rich_message)).toContain(
      '"url":"https://example.com"',
    );
    expect(requests[1]!.fields.text).toBe("More\nDownload");
    rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID", "Bad Request: message is too long");
    const text = `START${"x".repeat(4100)}END`;
    await expect(
      editMessageTelegram("123", 321, text, { cfg: richCfg, api: bot.api }),
    ).rejects.toThrow("message is too long");
    expect(requests.slice(2).map(({ method }) => method)).toEqual([
      "editMessageText",
      "editMessageText",
    ]);
    expect(requests.at(-1)!.fields.text).toBe(text);
  });

  it("retries idempotent edits after a real server rejection", async () => {
    rejections.push({ error_code: 502, description: "Bad Gateway" });
    await editMessageTelegram("123", 321, "Visible", {
      cfg,
      api: bot.api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    expect(requests).toEqual(
      Array.from({ length: 2 }, () => ({
        method: "editMessageText",
        fields: { chat_id: "123", message_id: 321, text: "Visible", parse_mode: "HTML" },
      })),
    );
  });
});
