import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAckReaction,
  resolveResponsePrefix,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "./identity.js";

describe("resolveAckReaction", () => {
  it("falls back to channel-level overrides", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { entries: { main: { identity: { emoji: "✅" } } } },
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

  it("falls back to the agent identity emoji when global config is unset", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { identity: { emoji: "🔥" } } } },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "discord" })).toBe("🔥");
  });

  it("returns the default emoji when no config is present", () => {
    const cfg: OpenClawConfig = {};

    expect(resolveAckReaction(cfg, "main")).toBe("👀");
  });
});

function prefixConfig(
  responsePrefix?: string,
  accounts?: Record<string, { responsePrefix?: string }>,
): OpenClawConfig {
  return {
    agents: { entries: { main: { identity: { name: "MyBot" } } } },
    channels: { whatsapp: { responsePrefix, accounts } },
  };
}

describe("response prefixes", () => {
  it("keeps the global fallback for a configured custom channel", () => {
    const cfg = {
      messages: { responsePrefix: "[Bot] " },
      channels: { custom: { enabled: true } },
    } as OpenClawConfig;
    expect(resolveResponsePrefix(cfg, "main", { channel: "custom" })).toBe("[Bot] ");
  });

  it("resolves 'auto' at account level to identity name", () => {
    const cfg = prefixConfig(undefined, { business: { responsePrefix: "auto" } });
    expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" })).toBe(
      "[MyBot]",
    );
  });

  it("passes channel context through to responsePrefix resolution", () => {
    const cfg = prefixConfig("[WA] ");
    const result = resolveEffectiveMessagesConfig(cfg, "main", {
      channel: "whatsapp",
    });
    expect(result.responsePrefix).toBe("[WA] ");
  });
});

describe("resolveHumanDelayConfig", () => {
  it("returns undefined when no humanDelay config is set", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveHumanDelayConfig(cfg, "main")).toBeUndefined();
  });

  it("merges defaults with per-agent overrides", () => {
    // Partial agent overrides should preserve unspecified timing bounds from
    // defaults while replacing the fields the agent owns.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          humanDelay: { mode: "natural", minMs: 800, maxMs: 1800 },
        },
        entries: { main: { humanDelay: { mode: "custom", minMs: 400 } } },
      },
    };

    expect(resolveHumanDelayConfig(cfg, "main")).toEqual({
      mode: "custom",
      minMs: 400,
      maxMs: 1800,
    });
  });
});
