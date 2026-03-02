import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { telegramUserbotAgentPromptAdapter } from "./agent-prompt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(caps?: Record<string, boolean>): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        apiId: 12345,
        apiHash: "abc123hash",
        ...(caps !== undefined ? { capabilities: caps } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

function getHints(caps?: Record<string, boolean>): string[] {
  return telegramUserbotAgentPromptAdapter.messageToolHints!({
    cfg: makeCfg(caps),
    accountId: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telegramUserbotAgentPromptAdapter", () => {
  describe("messageToolHints", () => {
    it("produces non-empty instructions", () => {
      const hints = getHints();
      expect(hints.length).toBeGreaterThan(0);
      // Should contain substantive lines, not just empty strings
      const nonEmpty = hints.filter((h) => h.trim().length > 0);
      expect(nonEmpty.length).toBeGreaterThan(3);
    });

    it("mentions all capabilities when all are enabled (defaults)", () => {
      const hints = getHints();
      const text = hints.join("\n");

      // Core userbot capabilities
      expect(text).toContain("forward messages");
      expect(text).toContain("pin");
      expect(text).toContain("react");
      expect(text).toContain("user account");

      // Default-on capabilities
      expect(text).toContain("delete other people");
      expect(text).toContain("history");
    });

    it("mentions all capabilities when explicitly enabled", () => {
      const hints = getHints({
        deleteOtherMessages: true,
        readHistory: true,
      });
      const text = hints.join("\n");

      expect(text).toContain("delete other people");
      expect(text).toContain("history");
    });

    it("excludes deleteOtherMessages hint when disabled", () => {
      const hints = getHints({ deleteOtherMessages: false });
      const text = hints.join("\n");

      expect(text).not.toContain("delete other people");
      // Other capabilities should still be present
      expect(text).toContain("forward messages");
      expect(text).toContain("pin");
    });

    it("excludes readHistory hint when disabled", () => {
      const hints = getHints({ readHistory: false });
      const text = hints.join("\n");

      expect(text).not.toContain("history");
      // Other capabilities should still be present
      expect(text).toContain("forward messages");
      expect(text).toContain("react");
    });

    it("excludes both optional capabilities when both disabled", () => {
      const hints = getHints({
        deleteOtherMessages: false,
        readHistory: false,
      });
      const text = hints.join("\n");

      expect(text).not.toContain("delete other people");
      expect(text).not.toContain("history");
      // Core capabilities still present
      expect(text).toContain("forward messages");
      expect(text).toContain("pin");
      expect(text).toContain("react");
    });

    it("includes channel name in output", () => {
      const hints = getHints();
      const text = hints.join("\n");
      expect(text).toContain("Telegram");
    });

    it("includes targeting guidance", () => {
      const hints = getHints();
      const text = hints.join("\n");
      expect(text).toContain("@username");
    });

    it("mentions messages appear as the user, not a bot", () => {
      const hints = getHints();
      const text = hints.join("\n");
      expect(text).toContain("not a bot");
    });
  });
});
