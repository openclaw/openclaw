import { beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { extractMessagingToolSend } from "./pi-embedded-subscribe.tools.js";

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
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

  it("keeps provider unset when message send omits channel/provider", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      to: "268300329",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBeUndefined();
    expect(result?.to).toBe("268300329");
  });

  it("captures explicit threadId for message sends", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "-100123",
      threadId: "77",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:-100123");
    expect(result?.threadId).toBe("77");
  });

  it("captures explicit threadId for telegram channel-tool sends", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
                if (args.action !== "sendMessage" || typeof args.to !== "string") {
                  return null;
                }
                return {
                  to: args.to,
                  threadId: typeof args.threadId === "string" ? args.threadId : undefined,
                };
              },
            },
          },
          source: "test",
        },
      ]),
    );

    const result = extractMessagingToolSend("telegram", {
      action: "sendMessage",
      to: "-100123",
      threadId: "88",
    });

    expect(result?.tool).toBe("telegram");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("-100123");
    expect(result?.threadId).toBe("88");
  });
});
