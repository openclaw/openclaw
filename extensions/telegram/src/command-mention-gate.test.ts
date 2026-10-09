import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isTelegramCommandAddressed } from "./command-mention-gate.js";

const botUsername = "mybot";
const botId = 1234;

function message(text: string, group = true): Message {
  return {
    message_id: 1,
    date: 1,
    chat: group
      ? { id: -1001, type: "supergroup", title: "Group" }
      : { id: 111, type: "private", first_name: "Sender" },
    from: { id: 111, is_bot: false, first_name: "Sender" },
    text,
    entities: text.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? text.length }]
      : [],
  } as Message;
}

function config(requireMention: boolean): OpenClawConfig {
  return { channels: { telegram: { groups: { "-1001": { requireMention } } } } };
}

describe("Telegram command mention gate", () => {
  it("requires an addressed command in mention-only groups", async () => {
    const cfg = config(true);
    const addressed = (text: string) =>
      isTelegramCommandAddressed({
        cfg,
        accountId: "default",
        msg: message(text),
        botUsername,
        botId,
      });
    expect(await addressed("/steer hello")).toBe(false);
    expect(await addressed("/steer@mybot hello")).toBe(true);
    expect(await addressed("/stop@otherbot")).toBe(false);
  });

  it("keeps bare commands in DMs and always-active groups", async () => {
    expect(
      await isTelegramCommandAddressed({
        cfg: config(true),
        accountId: "default",
        msg: message("/steer hello", false),
        botUsername,
        botId,
      }),
    ).toBe(true);
    expect(
      await isTelegramCommandAddressed({
        cfg: config(false),
        accountId: "default",
        msg: message("/steer hello"),
        botUsername,
        botId,
      }),
    ).toBe(true);
  });
});
