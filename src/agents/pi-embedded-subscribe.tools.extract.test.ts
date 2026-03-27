import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTelegramMessagingTarget } from "../../extensions/telegram/src/normalize.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSends,
} from "./pi-embedded-subscribe.tools.js";

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { normalizeTarget: normalizeTelegramMessagingTarget },
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) => ({
                to: typeof args.to === "string" ? args.to : undefined,
                accountId: typeof args.accountId === "string" ? args.accountId : undefined,
              }),
            },
          },
          source: "test",
        },
      ]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      channel: "telegram",
      to: "channel:C1",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("slack");
    expect(result?.to).toBe("channel:C1");
  });

  it("accepts target alias when to is omitted", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("keeps provider unset when message send omits channel and provider", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      to: "268300329",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBeUndefined();
    expect(result?.to).toBe("268300329");
  });

  it("records threadId for route-scoped message sends", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
      threadId: 42,
    });

    expect(result?.threadId).toBe("42");
  });

  it("tracks channelId when it is the only legacy target alias", () => {
    const result = extractMessagingToolSends("message", {
      action: "send",
      channel: "telegram",
      channelId: "555",
      threadId: "99",
    });

    expect(result).toEqual([
      { tool: "message", provider: "telegram", to: "telegram:555", threadId: "99" },
    ]);
  });

  it("prefers the resolved send target over stray alias fields", () => {
    const result = extractMessagingToolSends("message", {
      action: "send",
      channel: "telegram",
      to: "123",
      channelId: "555",
      targets: ["456", "789"],
    });

    expect(result).toEqual([{ tool: "message", provider: "telegram", to: "telegram:123" }]);
  });

  it("tracks implicit current-route sends when message target is omitted", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        content: "same route",
      },
      {
        currentChannelProvider: "telegram",
        currentChannelId: "123",
      },
    );

    expect(result).toEqual({
      tool: "message",
      provider: "telegram",
      to: "telegram:123",
    });
  });

  it("ignores numeric target aliases and falls back to the current route", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        to: 12345,
        content: "same route",
      },
      {
        currentChannelProvider: "telegram",
        currentChannelId: "123",
      },
    );

    expect(result).toEqual({
      tool: "message",
      provider: "telegram",
      to: "telegram:123",
    });
  });

  it("preserves implicit Telegram topic threading for same-chat sends", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        channel: "telegram",
        to: "123",
      },
      {
        currentChannelProvider: "telegram",
        currentChannelId: "123",
        currentThreadTs: "77",
      },
    );

    expect(result).toEqual({
      tool: "message",
      provider: "telegram",
      to: "telegram:123",
      threadId: "77",
    });
  });

  it("captures messageThreadId aliases for Telegram sends", () => {
    const result = extractMessagingToolSend("telegram", {
      to: "123",
      messageThreadId: 77,
    });

    expect(result).toEqual({
      tool: "telegram",
      provider: "telegram",
      to: "telegram:123",
      threadId: "77",
    });
  });
});
