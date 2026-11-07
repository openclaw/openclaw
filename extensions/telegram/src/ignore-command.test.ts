import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { resolveTelegramIgnoreDisposition } from "./ignore-command.js";

function message(text?: string, overrides: Partial<Message> = {}): Message {
  const token = text ? /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text)?.[0] : undefined;
  return {
    chat: { id: -42, type: "group", title: "Ops" },
    message_id: 1,
    date: 1,
    from: { id: 7, is_bot: false, first_name: "Ada" },
    ...(text ? { text } : {}),
    entities: token ? [{ type: "bot_command", offset: 0, length: token.length }] : [],
    ...overrides,
  } as Message;
}

describe("resolveTelegramIgnoreDisposition", () => {
  it.each([
    [message("/ignore keep this out"), "OpenClawBot", "exclude"],
    [message("/ignore"), "OpenClawBot", "help"],
    [message("/ignore@OpenClawBot hidden"), "OpenClawBot", "exclude"],
    [message("/ignore@OtherBot hidden"), "OpenClawBot", "keep"],
    [message("/ignoreme hidden"), "OpenClawBot", "keep"],
    [message("/ignore hidden", { entities: [] }), "OpenClawBot", "keep"],
    [
      message("/ignore hidden", {
        from: { id: 8, is_bot: true, first_name: "Automation" },
      }),
      "OpenClawBot",
      "keep",
    ],
    [{ ...message("/ignore hidden"), from: undefined }, "OpenClawBot", "keep"],
    [message(undefined, { caption: "/ignore hidden photo" }), "OpenClawBot", "keep"],
    [
      message("/ignore hidden", {
        forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Ada" },
      }),
      "OpenClawBot",
      "keep",
    ],
  ] as const)("classifies %#", (input, botUsername, expected) => {
    expect(resolveTelegramIgnoreDisposition(input, botUsername)).toBe(expected);
  });
});
