import { resetGlobalHookRunner } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramRichMarkdownPlan } from "./rich-message.js";
import { editMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const mediaMarkdown = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `<figure><img src="https://example.com/${index + 1}.jpg"/><figcaption>photo-${index + 1}</figcaption></figure>`,
  ).join("\n\n");

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

  it.each([
    { count: 20, native: false },
    { count: 21, native: false },
    { count: 20, native: true },
    { count: 21, native: true },
  ])(
    "edits all $count media without truncation (native blocks: $native)",
    async ({ count, native }) => {
      const text = `${mediaMarkdown(count)}\n\nTAIL`;
      await editMessageTelegram("123", 321, text, {
        cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
        api: bot.api,
        ...(native ? { richMessage: buildTelegramRichMarkdownPlan(text).richMessage } : {}),
      });
      expect(requests.map(({ method }) => method)).toEqual(["editMessageText"]);
      const fields = requests[0]!.fields;
      expect(fields.message_id).toBe(321);
      if (count === 20) {
        expect(fields.rich_message).toBeDefined();
        expect(fields.text).toBeUndefined();
      } else {
        expect(fields.rich_message).toBeUndefined();
        expect(fields.text).toBe(
          Array.from(
            { length: count },
            (_, index) => `photo-${index + 1} https://example.com/${index + 1}.jpg`,
          ).join("\n") + "\nTAIL",
        );
      }
      expect(JSON.stringify(fields).match(/https:\/\/example\.com\/\d+\.jpg/g)).toEqual(
        Array.from({ length: count }, (_, index) => `https://example.com/${index + 1}.jpg`),
      );
      expect(JSON.stringify(fields)).toContain("TAIL");
    },
  );

  it.each([
    { length: 4001, character: "x" },
    { length: 4096, character: "x" },
    { length: 4097, character: "x" },
    { length: 4096, character: "😀" },
    { length: 4097, character: "😀" },
  ])(
    "bounds the complete $length-character 21-media replacement with $character before HTTP",
    async ({ length, character }) => {
      const prefix =
        Array.from(
          { length: 21 },
          (_, index) => `photo-${index + 1} https://example.com/${index + 1}.jpg`,
        ).join("\n") + "\n";
      const tail = `${character.repeat(length - prefix.length - 4)}TAIL`;
      const buttons = [[{ text: "Keep", callback_data: "keep" }]];
      const result = editMessageTelegram("123", 321, `${mediaMarkdown(21)}\n\n${tail}`, {
        cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
        api: bot.api,
        buttons,
        linkPreview: false,
      });
      if (length > 4096) {
        await expect(result).rejects.toThrow(
          "complete plain fallback is 4097 characters, exceeding the 4096-character edit limit",
        );
        expect(requests).toEqual([]);
      } else {
        await expect(result).resolves.toMatchObject({ ok: true, messageId: "321", chatId: "123" });
        expect(requests).toEqual([
          {
            method: "editMessageText",
            fields: {
              chat_id: "123",
              message_id: 321,
              text: prefix + tail,
              link_preview_options: { is_disabled: true },
              reply_markup: { inline_keyboard: buttons },
            },
          },
        ]);
      }
    },
  );

  it.each([4001, 4096])("recovers a complete %i-character rich edit", async (length) => {
    const text = `START${"x".repeat(length - 8)}END`;
    rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
    await editMessageTelegram("123", 321, text, {
      cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
      api: bot.api,
    });
    expect(requests.map(({ method }) => method)).toEqual(["editMessageText", "editMessageText"]);
    expect(requests[0]!.fields.rich_message).toBeDefined();
    expect(requests[1]!.fields).toEqual({ chat_id: "123", message_id: 321, text });
  });

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
    rejections.push("Bad Request: RICH_MESSAGE_URL_INVALID");
    const text = `START${"x".repeat(4100)}END`;
    await expect(
      editMessageTelegram("123", 321, text, { cfg: richCfg, api: bot.api }),
    ).rejects.toThrow(
      "complete plain fallback is 4108 characters, exceeding the 4096-character edit limit",
    );
    expect(requests.slice(2).map(({ method }) => method)).toEqual(["editMessageText"]);
    expect(requests.at(-1)!.fields.rich_message).toBeDefined();
    expect(requests.at(-1)!.fields.text).toBeUndefined();
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
