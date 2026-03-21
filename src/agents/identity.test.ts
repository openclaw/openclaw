import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAckReaction, resolveWhatsAppAckEmoji } from "./identity.js";

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

  it("extracts emoji from a WhatsApp-style object at channel level", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          ackReaction: { emoji: "🍓", direct: true, group: "mentions" },
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "whatsapp" })).toBe("🍓");
  });

  it("falls back to agent identity emoji when WhatsApp ackReaction has no emoji field", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "kit", identity: { emoji: "🎸" } }] },
      channels: {
        whatsapp: {
          ackReaction: { direct: true, group: "mentions" },
        },
      },
    };

    expect(resolveAckReaction(cfg, "kit", { channel: "whatsapp" })).toBe("🎸");
  });

  it("treats empty emoji in a WhatsApp object as disabled (does not fall through to identity)", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          ackReaction: { emoji: "", direct: true },
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "whatsapp" })).toBe("");
  });

  it("extracts emoji from a WhatsApp-style object at account level", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          // oxlint-disable-next-line typescript/no-explicit-any
          accounts: { biz: { ackReaction: { emoji: "💼" } as any } },
        },
      },
    };

    expect(resolveAckReaction(cfg, "main", { channel: "whatsapp", accountId: "biz" })).toBe("💼");
  });
});

describe("resolveWhatsAppAckEmoji", () => {
  it("returns empty string when ackReaction is not configured", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main")).toBe("");
  });

  it("does not fall through to messages.ackReaction (L3) when emoji is absent", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "🎸" } }] },
      channels: {
        whatsapp: {
          ackReaction: { direct: false },
        },
      },
    };

    // Must use agent identity emoji, not messages.ackReaction
    expect(resolveWhatsAppAckEmoji(cfg, "main")).toBe("🎸");
  });

  it("uses the configured channel emoji", () => {
    const cfg: OpenClawConfig = {
      messages: { ackReaction: "👀" },
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          ackReaction: { emoji: "🍓", direct: true },
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main")).toBe("🍓");
  });

  it("treats empty emoji as disabled (does not fall through to agent identity)", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          ackReaction: { emoji: "" },
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main")).toBe("");
  });

  it("falls back to agent identity emoji when ackReaction is configured but emoji is absent", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "kit", identity: { emoji: "🎸" } }] },
      channels: {
        whatsapp: {
          ackReaction: { direct: true, group: "mentions" },
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "kit")).toBe("🎸");
  });

  it("resolves account-level emoji when no channel-level ackReaction is configured", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          // oxlint-disable-next-line typescript/no-explicit-any
          accounts: { personal: { ackReaction: { emoji: "🌟" } as any } },
          // no channel-level ackReaction
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main", { accountId: "personal" })).toBe("🌟");
  });

  it("falls to agent identity when account ackReaction has no emoji and no channel ackReaction", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          // oxlint-disable-next-line typescript/no-explicit-any
          accounts: { personal: { ackReaction: { direct: false } as any } },
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main", { accountId: "personal" })).toBe("🔥");
  });

  it("prefers account-level emoji over channel-level", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", identity: { emoji: "🔥" } }] },
      channels: {
        whatsapp: {
          ackReaction: { emoji: "🍓" },
          // oxlint-disable-next-line typescript/no-explicit-any
          accounts: { biz: { ackReaction: { emoji: "💼" } as any } },
        },
      },
    };

    expect(resolveWhatsAppAckEmoji(cfg, "main", { accountId: "biz" })).toBe("💼");
  });
});
