import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAckReaction, resolveAckSticker } from "./identity.js";

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

describe("resolveAckSticker", () => {
  it("prefers scoped topic/group overrides", () => {
    const cfg: OpenClawConfig = {
      messages: { ackSticker: { fileId: "global" } },
      channels: {
        telegram: {
          ackSticker: { fileId: "channel" },
          accounts: {
            main: { ackSticker: { fileId: "account" } },
          },
        },
      },
    };

    expect(
      resolveAckSticker(cfg, "main", {
        channel: "telegram",
        accountId: "main",
        scopedConfigs: [{ ackSticker: { fileId: "topic" } }],
      }),
    ).toEqual({ fileId: "topic" });
  });

  it("falls back from account to channel to global without identity fallback", () => {
    const cfg: OpenClawConfig = {
      messages: { ackSticker: { fileId: "global" } },
      channels: {
        telegram: {
          ackSticker: { fileId: " channel " },
          accounts: {
            other: { ackSticker: { fileId: "account" } },
          },
        },
      },
    };

    expect(resolveAckSticker(cfg, "main", { channel: "telegram", accountId: "missing" })).toEqual({
      fileId: "channel",
    });
    expect(resolveAckSticker({ messages: { ackSticker: { fileId: " global " } } }, "main")).toEqual(
      {
        fileId: "global",
      },
    );
    expect(resolveAckSticker({}, "main")).toBeUndefined();
  });

  it("preserves disabled overrides without requiring a file id", () => {
    const cfg: OpenClawConfig = {
      messages: { ackSticker: { fileId: "global" } },
      channels: {
        telegram: {
          ackSticker: { scope: "off" },
        },
      },
    };

    expect(resolveAckSticker(cfg, "main", { channel: "telegram" })).toEqual({ scope: "off" });
  });
});
