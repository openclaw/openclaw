import { describe, expect, it } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";

describe("resolveSlackChannelConfig", () => {
  it("returns per-channel replyToMode when configured", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C0ABC12345",
      channels: {
        C0ABC12345: { allow: true, replyToMode: "all" },
      },
      defaultRequireMention: false,
    });
    expect(result).not.toBeNull();
    expect(result!.replyToMode).toBe("all");
  });

  it("falls back to wildcard replyToMode when channel has no override", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C0ABC12345",
      channels: {
        "*": { allow: true, replyToMode: "first" },
      },
      defaultRequireMention: false,
    });
    expect(result).not.toBeNull();
    expect(result!.replyToMode).toBe("first");
  });

  it("prefers exact channel replyToMode over wildcard", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C0ABC12345",
      channels: {
        C0ABC12345: { allow: true, replyToMode: "off" },
        "*": { allow: true, replyToMode: "all" },
      },
      defaultRequireMention: false,
    });
    expect(result).not.toBeNull();
    expect(result!.replyToMode).toBe("off");
  });

  it("falls back to wildcard replyToMode when exact channel entry omits it", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C0ABC12345",
      channels: {
        C0ABC12345: { allow: true },
        "*": { allow: true, replyToMode: "first" },
      },
      defaultRequireMention: false,
    });
    expect(result).not.toBeNull();
    expect(result!.replyToMode).toBe("first");
  });

  it("returns undefined replyToMode when not configured", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C0ABC12345",
      channels: {
        C0ABC12345: { allow: true },
      },
      defaultRequireMention: false,
    });
    expect(result).not.toBeNull();
    expect(result!.replyToMode).toBeUndefined();
  });
});
