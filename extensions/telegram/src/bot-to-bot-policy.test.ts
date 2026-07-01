import { describe, expect, it } from "vitest";
import { normalizeTelegramBotToBotId, resolveTelegramBotToBotPolicy } from "./bot-to-bot-policy.js";

describe("resolveTelegramBotToBotPolicy", () => {
  it("denies bot sender when disabled by default", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "disabled_bot_sender",
    });
  });

  it("allows an enabled allowlisted numeric bot ID", () => {
    const decision = resolveTelegramBotToBotPolicy({
      message: { chat: { id: 42 }, message_id: 100 },
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [10] },
      metadata: { accountId: "ops", updateId: 200 },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      senderUsername: "helperbot",
      senderId: "10",
      normalizedAllowBotIds: ["10"],
      dedupeKey: "telegram:ops:update:200",
      senderScopeKey: "telegram-bot-to-bot:ops:42:10",
    });
  });

  it("denies same username with a wrong numeric bot ID", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 99, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [10] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "unknown_bot_sender",
    });
  });

  it("denies same username when sender ID is missing", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [10] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "unknown_bot_sender",
      senderUsername: "helperbot",
      normalizedAllowBotIds: ["10"],
    });
  });

  it("denies an unknown numeric bot sender", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "OtherBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [11] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "unknown_bot_sender",
    });
  });

  it("denies self-loop messages by numeric ID before other policy checks", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 1, username: "DifferentName", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [1] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "self_loop",
    });
  });

  it("denies bot senders when kill switch is enabled", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, killSwitch: true, allowBotIds: [10] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "kill_switch",
    });
  });

  it("allows human messages unchanged", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "Dmitry", is_bot: false },
      me: { id: 1, username: "MainBot", is_bot: true },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "human_sender",
      senderUsername: "dmitry",
    });
  });

  it("normalizes Telegram bot-to-bot numeric IDs", () => {
    expect(normalizeTelegramBotToBotId(" 001234 ")).toBe("1234");
    expect(normalizeTelegramBotToBotId(1234)).toBe("1234");
    expect(normalizeTelegramBotToBotId("@HelperBot")).toBeUndefined();

    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "@HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [" 0010 "] },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      senderUsername: "helperbot",
      normalizedAllowBotIds: ["10"],
    });
  });

  it("prepares dedupe and numeric sender scope keys", () => {
    const decision = resolveTelegramBotToBotPolicy({
      message: { chat: { id: "-1001" }, message_id: 55 },
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowBotIds: [10] },
      metadata: { accountId: "ops" },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      dedupeKey: "telegram:ops:message:-1001:55",
      senderScopeKey: "telegram-bot-to-bot:ops:-1001:10",
    });
  });
});
