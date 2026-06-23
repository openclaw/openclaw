import { describe, expect, it } from "vitest";
import {
  normalizeTelegramBotToBotUsername,
  resolveTelegramBotToBotPolicy,
} from "./bot-to-bot-policy.js";

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

  it("allows an enabled allowlisted bot username", () => {
    const decision = resolveTelegramBotToBotPolicy({
      message: { chat: { id: 42 }, message_id: 100 },
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowUsernames: ["helperbot"] },
      metadata: { accountId: "ops", updateId: 200 },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      senderUsername: "helperbot",
      dedupeKey: "telegram:ops:update:200",
      senderScopeKey: "telegram-bot-to-bot:ops:42:helperbot",
      rateLimitKey: "telegram-bot-to-bot:ops:42:helperbot",
    });
  });

  it("denies an unknown bot sender", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "OtherBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowUsernames: ["helperbot"] },
    });

    expect(decision).toMatchObject({
      decision: "drop",
      allow: false,
      reason: "unknown_bot_sender",
    });
  });

  it("denies self-loop messages before other policy checks", () => {
    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 1, username: "MainBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowUsernames: ["mainbot"] },
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
      config: { enabled: true, killSwitch: true, allowUsernames: ["helperbot"] },
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

  it("normalizes usernames without @ and lower-case", () => {
    expect(normalizeTelegramBotToBotUsername(" @HelperBot ")).toBe("helperbot");

    const decision = resolveTelegramBotToBotPolicy({
      from: { id: 10, username: "@HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: { enabled: true, allowUsernames: [" @HELPERBOT "] },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      normalizedAllowUsernames: ["helperbot"],
    });
  });

  it("prepares max depth, max hops, dedupe, and rate-limit keys", () => {
    const decision = resolveTelegramBotToBotPolicy({
      message: { chat: { id: "-1001" }, message_id: 55 },
      from: { id: 10, username: "HelperBot", is_bot: true },
      me: { id: 1, username: "MainBot", is_bot: true },
      config: {
        enabled: true,
        allowUsernames: ["helperbot"],
        maxDepth: 3,
        maxHops: 4,
        rateLimit: { windowMs: 60_000, maxMessages: 5 },
      },
      metadata: { accountId: "ops", depth: 2, hops: 3 },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      allow: true,
      reason: "allowlisted_bot_sender",
      dedupeKey: "telegram:ops:message:-1001:55",
      senderScopeKey: "telegram-bot-to-bot:ops:-1001:helperbot",
      rateLimitKey: "telegram-bot-to-bot:ops:-1001:helperbot",
      maxDepth: 3,
      maxHops: 4,
    });
  });
});
