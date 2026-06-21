/**
 * Regression coverage for identity-driven acknowledgement reactions.
 * Confirms account, channel, global, identity, and explicit-empty precedence.
 */
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

  it('falls back to channels["*"].ackReaction when the channel has no specific override', () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "✅" },
      agents: { list: [{ id: "main", identity: { emoji: "😺" } }] },
      channels: {
        "*": { ackReaction: "🎯" },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("🎯");
  });

  it('prefers a concrete channel-level ackReaction over the channels["*"] wildcard', () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "✅" },
      agents: { list: [{ id: "main", identity: { emoji: "😺" } }] },
      channels: {
        "*": { ackReaction: "🎯" },
        slack: { ackReaction: "👍" },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "slack" })).toBe("👍");
  });

  it('falls back to channels["*"].ackReaction when the concrete channel config exists but lacks ackReaction', () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "✅" },
      agents: { list: [{ id: "main", identity: { emoji: "😺" } }] },
      channels: {
        "*": { ackReaction: "🎯" },
        slack: { token: "configured-but-no-ackreaction" },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "slack" })).toBe("🎯");
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
