import type { ChannelThreadingContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, it, expect } from "vitest";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

function createMockContext(
  overrides: Partial<ChannelThreadingContext> = {},
): ChannelThreadingContext {
  return {
    To: "group:-1001234567890",
    ChatType: "group",
    MessageThreadId: 42,
    ...overrides,
  };
}

const mockCfg: OpenClawConfig = {
  channels: {
    telegram: {
      enabled: true,
      accounts: {
        default: {
          enabled: true,
        },
      },
    },
  },
};

describe("buildTelegramThreadingToolContext", () => {
  it("returns toolContext with currentThreadTs when MessageThreadId is present", () => {
    const context = createMockContext({
      MessageThreadId: 42,
      To: "group:-1001234567890",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result).toBeDefined();
    // parseTelegramTarget preserves the "group:" prefix in chatId
    expect(result?.currentChannelId).toBe("group:-1001234567890");
    expect(result?.currentThreadTs).toBe("42");
    expect(result?.hasRepliedRef).toBeUndefined();
  });

  it("returns undefined when MessageThreadId is undefined", () => {
    const context = createMockContext({
      MessageThreadId: undefined,
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result).toBeUndefined();
  });

  it("extracts chat ID correctly from group To field", () => {
    const context = createMockContext({
      MessageThreadId: 100,
      To: "group:-1009876543210",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // parseTelegramTarget preserves the "group:" prefix in chatId
    expect(result?.currentChannelId).toBe("group:-1009876543210");
    expect(result?.currentThreadTs).toBe("100");
  });

  it("extracts chat ID correctly from DM To field", () => {
    const context = createMockContext({
      MessageThreadId: 200,
      To: "123456",
      ChatType: "direct",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    expect(result?.currentChannelId).toBe("123456");
    expect(result?.currentThreadTs).toBe("200");
  });

  it("passes hasRepliedRef through when provided", () => {
    const context = createMockContext({
      MessageThreadId: 42,
    });
    const repliedRef = { value: false };

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
      hasRepliedRef: repliedRef,
    });

    expect(result?.hasRepliedRef).toBe(repliedRef);
  });

  it("handles forum topic with large thread ID", () => {
    const context = createMockContext({
      MessageThreadId: 999999,
      To: "group:-1001111222333",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // parseTelegramTarget preserves the "group:" prefix in chatId
    expect(result?.currentChannelId).toBe("group:-1001111222333");
    expect(result?.currentThreadTs).toBe("999999");
  });

  it("does not use ReplyToIdFull as fallback", () => {
    const context = createMockContext({
      MessageThreadId: undefined,
      ReplyToIdFull: "999",
    });

    const result = buildTelegramThreadingToolContext({
      cfg: mockCfg,
      accountId: "default",
      context,
    });

    // ReplyToIdFull should not be used as fallback
    expect(result).toBeUndefined();
  });
});
