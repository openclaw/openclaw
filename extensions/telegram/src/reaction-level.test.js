import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
describe("resolveTelegramReactionLevel", () => {
  const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const expectReactionFlags = (result, expected) => {
    expect(result.level).toBe(expected.level);
    expect(result.ackEnabled).toBe(expected.ackEnabled);
    expect(result.agentReactionsEnabled).toBe(expected.agentReactionsEnabled);
    expect(result.agentReactionGuidance).toBe(expected.agentReactionGuidance);
  };
  const expectMinimalFlags = (result) => {
    expectReactionFlags(result, {
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal"
    });
  };
  const expectExtensiveFlags = (result) => {
    expectReactionFlags(result, {
      level: "extensive",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "extensive"
    });
  };
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });
  afterAll(() => {
    if (prevTelegramToken === void 0) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
    }
  });
  it("defaults to minimal level when reactionLevel is not set", () => {
    const cfg = {
      channels: { telegram: {} }
    };
    const result = resolveTelegramReactionLevel({ cfg });
    expectMinimalFlags(result);
  });
  it("returns off level with no reactions enabled", () => {
    const cfg = {
      channels: { telegram: { reactionLevel: "off" } }
    };
    const result = resolveTelegramReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "off",
      ackEnabled: false,
      agentReactionsEnabled: false
    });
  });
  it("returns ack level with only ackEnabled", () => {
    const cfg = {
      channels: { telegram: { reactionLevel: "ack" } }
    };
    const result = resolveTelegramReactionLevel({ cfg });
    expectReactionFlags(result, {
      level: "ack",
      ackEnabled: true,
      agentReactionsEnabled: false
    });
  });
  it("returns minimal level with agent reactions enabled and minimal guidance", () => {
    const cfg = {
      channels: { telegram: { reactionLevel: "minimal" } }
    };
    const result = resolveTelegramReactionLevel({ cfg });
    expectMinimalFlags(result);
  });
  it("returns extensive level with agent reactions enabled and extensive guidance", () => {
    const cfg = {
      channels: { telegram: { reactionLevel: "extensive" } }
    };
    const result = resolveTelegramReactionLevel({ cfg });
    expectExtensiveFlags(result);
  });
  it("resolves reaction level from a specific account", () => {
    const cfg = {
      channels: {
        telegram: {
          reactionLevel: "ack",
          accounts: {
            work: { botToken: "tok-work", reactionLevel: "extensive" }
          }
        }
      }
    };
    const result = resolveTelegramReactionLevel({ cfg, accountId: "work" });
    expectExtensiveFlags(result);
  });
  it("falls back to global level when account has no reactionLevel", () => {
    const cfg = {
      channels: {
        telegram: {
          reactionLevel: "minimal",
          accounts: {
            work: { botToken: "tok-work" }
          }
        }
      }
    };
    const result = resolveTelegramReactionLevel({ cfg, accountId: "work" });
    expectMinimalFlags(result);
  });
});
