import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAckReaction } from "./identity.js";

describe("resolveAckReaction", () => {
  it("prefers account-level overrides", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "✅" } }] },
      channels: {
        slack: {
          ackReaction: "eyes",
          accounts: {
            acct1: { ackReaction: " party_parrot " },
          },
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "slack", accountId: "acct1" })).toBe(
      "party_parrot",
    );
  });

  it("falls back to channel-level overrides", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "✅" } }] },
      channels: {
        slack: {
          ackReaction: "eyes",
          accounts: {
            acct1: { ackReaction: "party_parrot" },
          },
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "slack", accountId: "missing" })).toBe(
      "eyes",
    );
  });

  it("uses the global ackReaction when channel overrides are missing", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "✅" },
      agents: { list: [{ id: "main", identity: { emoji: "😺" } }] },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("✅");
  });

  it("falls back to the agent identity emoji when global config is unset", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("🔥");
  });

  it("returns the default emoji when no config is present", () => {
    const cfg: OpenClawConfig = {};

    expect(resolveAckReaction(cfg, "main")).toBe("👀");
  });

  it("uses channelDefault when no user config or identity emoji is present", () => {
    const cfg: OpenClawConfig = {};

    expect(resolveAckReaction(cfg, "main", { channel: "feishu", channelDefault: "Typing" })).toBe(
      "Typing",
    );
  });

  it("channelDefault is overridden by identity emoji", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
    };

    // Identity emoji is Unicode so channelDefault should take effect since
    // reply-dispatcher validates emoji_type separately; but resolveAckReaction
    // still returns the identity emoji — validation happens at call site.
    expect(resolveAckReaction(cfg, "main", { channel: "feishu", channelDefault: "Typing" })).toBe(
      "🔥",
    );
  });

  it("allows empty strings to disable reactions", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      channels: {
        telegram: {
          ackReaction: "",
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "telegram" })).toBe("");
  });
});
