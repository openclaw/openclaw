import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to partial when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("partial");
    expect(resolveTelegramStreamMode({})).toBe("partial");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("maps legacy streamMode values", () => {
    expect(resolveTelegramStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveTelegramStreamMode({ streamMode: "partial" })).toBe("partial");
    expect(resolveTelegramStreamMode({ streamMode: "block" })).toBe("block");
  });

  it("maps unified progress mode to partial on Telegram", () => {
    expect(resolveTelegramStreamMode({ streaming: "progress" })).toBe("partial");
  });
});

describe("resolveTelegramDraftStreamingChunking", () => {
  it("uses smaller defaults than block streaming", () => {
    const chunking = resolveTelegramDraftStreamingChunking(undefined, "default");
    expect(chunking).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });

  it("clamps to telegram.textChunkLimit", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { allowFrom: ["*"], textChunkLimit: 150 } },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 150,
      maxChars: 150,
      breakPreference: "paragraph",
    });
  });

  it("supports per-account overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["*"],
          accounts: {
            default: {
              allowFrom: ["*"],
              streaming: {
                preview: {
                  chunk: {
                    minChars: 10,
                    maxChars: 20,
                    breakPreference: "sentence",
                  },
                },
              },
            },
          },
        },
      },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "sentence",
    });
  });
});

describe("buildTelegramMessageSid", () => {
  it("scopes Telegram message ids by account, chat, and thread", async () => {
    const { buildTelegramMessageSid } = await import("./bot/helpers.js");

    expect(
      buildTelegramMessageSid({
        accountId: "bot-a",
        chatId: -1001234567890,
        messageThreadId: 42,
        messageId: 1001,
      }),
    ).toBe("telegram:bot-a:-1001234567890:42:1001");
  });

  it("keeps chat-level and thread-level Telegram messages distinct", async () => {
    const { buildTelegramMessageSid } = await import("./bot/helpers.js");

    const chatLevel = buildTelegramMessageSid({
      accountId: "default",
      chatId: -1001234567890,
      messageId: 1001,
    });
    const topicLevel = buildTelegramMessageSid({
      accountId: "default",
      chatId: -1001234567890,
      messageThreadId: 42,
      messageId: 1001,
    });

    expect(chatLevel).toBe("telegram:default:-1001234567890::1001");
    expect(topicLevel).toBe("telegram:default:-1001234567890:42:1001");
    expect(chatLevel).not.toBe(topicLevel);
  });

  it("allows native command turns to avoid colliding with message turns", async () => {
    const { buildTelegramMessageSid } = await import("./bot/helpers.js");

    expect(
      buildTelegramMessageSid({
        accountId: "default",
        chatId: 1234,
        messageId: 7,
        namespace: "slash",
      }),
    ).toBe("telegram:default:1234::slash:7");
  });
});
