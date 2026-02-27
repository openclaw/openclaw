import { beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
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
});
