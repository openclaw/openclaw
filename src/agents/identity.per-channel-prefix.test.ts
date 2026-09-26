// Documents response-prefix cascade across global, channel, and account scopes.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveResponsePrefix, resolveEffectiveMessagesConfig } from "./identity.js";

function prefixConfig(
  responsePrefix?: string,
  accounts?: Record<string, { responsePrefix?: string }>,
): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", identity: { name: "MyBot" } }] },
    channels: { whatsapp: { responsePrefix, accounts } },
  };
}

describe("resolveResponsePrefix with per-channel override", () => {
  it("keeps the global fallback when no channel block exists", () => {
    const cfg: OpenClawConfig = { messages: { responsePrefix: "[Bot] " } };
    expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBe("[Bot] ");
  });

  it("keeps the global fallback for a configured custom channel", () => {
    const cfg = {
      messages: { responsePrefix: "[Bot] " },
      channels: { custom: { enabled: true } },
    } as OpenClawConfig;
    expect(resolveResponsePrefix(cfg, "main", { channel: "custom" })).toBe("[Bot] ");
  });

  describe("channel-level prefix", () => {
    it("resolves 'auto' at channel level to identity name", () => {
      const cfg = prefixConfig("auto");
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[MyBot]");
    });

    it("different channels get different prefixes", () => {
      const cfg = {
        channels: {
          whatsapp: { responsePrefix: "[WA Bot] " },
          telegram: { responsePrefix: "" },
          discord: { responsePrefix: "🤖 " },
        },
      } satisfies OpenClawConfig;
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[WA Bot] ");
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBe("");
      expect(resolveResponsePrefix(cfg, "main", { channel: "discord" })).toBe("🤖 ");
    });

    it("returns undefined when channel not in config", () => {
      const cfg = prefixConfig("[WA] ");
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBeUndefined();
    });
  });

  describe("account-level prefix", () => {
    it("falls through to channel prefix when account prefix is undefined", () => {
      const cfg = prefixConfig("[WA] ", { business: {} });
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[WA] ");
    });

    it("account empty string stops cascade", () => {
      const cfg = prefixConfig("[WA] ", { business: { responsePrefix: "" } });
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("");
    });

    it("resolves 'auto' at account level to identity name", () => {
      const cfg = prefixConfig(undefined, { business: { responsePrefix: "auto" } });
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[MyBot]");
    });

    it("different accounts on same channel get different prefixes", () => {
      const cfg = prefixConfig("[WA] ", {
        business: { responsePrefix: "[Biz] " },
        personal: { responsePrefix: "[Personal] " },
      });
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[Biz] ");
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "personal" }),
      ).toBe("[Personal] ");
    });

    it("unknown accountId falls through to channel level", () => {
      const cfg = prefixConfig("[WA] ", { business: { responsePrefix: "[Biz] " } });
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "unknown" }),
      ).toBe("[WA] ");
    });
  });

  describe("resolveEffectiveMessagesConfig with channel context", () => {
    it("passes channel context through to responsePrefix resolution", () => {
      const cfg = prefixConfig("[WA] ");
      const result = resolveEffectiveMessagesConfig(cfg, "main", {
        channel: "whatsapp",
      });
      expect(result.responsePrefix).toBe("[WA] ");
    });

    it("returns undefined when no channel context is provided", () => {
      const cfg = prefixConfig("[WA] ");
      const result = resolveEffectiveMessagesConfig(cfg, "main");
      expect(result.responsePrefix).toBeUndefined();
    });
  });
});
