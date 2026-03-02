import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { telegramUserbotOnboardingAdapter } from "./onboarding.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(extra: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        ...extra,
      },
    },
  } as unknown as OpenClawConfig;
}

function makePrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    text: vi.fn().mockResolvedValue(""),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue(""),
    note: vi.fn(),
    ...overrides,
  } as unknown as WizardPrompter;
}

const defaults = {
  runtime: {} as never,
  options: undefined,
  accountOverrides: {} as Record<string, string>,
  shouldPromptAccountIds: false,
  forceAllowFrom: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telegramUserbotOnboardingAdapter", () => {
  describe("getStatus", () => {
    it("returns configured when apiId and apiHash are set", async () => {
      const status = await telegramUserbotOnboardingAdapter.getStatus({
        cfg: makeCfg({ apiId: 12345, apiHash: "abc123hash" }),
        accountOverrides: {},
      });
      expect(status.configured).toBe(true);
      expect(status.channel).toBe("telegram-userbot");
    });

    it("returns not configured when credentials are missing", async () => {
      const status = await telegramUserbotOnboardingAdapter.getStatus({
        cfg: makeCfg(),
        accountOverrides: {},
      });
      expect(status.configured).toBe(false);
    });

    it("returns not configured when apiId is 0", async () => {
      const status = await telegramUserbotOnboardingAdapter.getStatus({
        cfg: makeCfg({ apiId: 0, apiHash: "" }),
        accountOverrides: {},
      });
      expect(status.configured).toBe(false);
    });
  });

  describe("configure", () => {
    it("prompts for API credentials and saves to config", async () => {
      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345678") // apiId
          .mockResolvedValueOnce("0123456789abcdef0123456789abcdef"), // apiHash
      });

      const result = await telegramUserbotOnboardingAdapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.apiId).toBe(12345678);
      expect(section.apiHash).toBe("0123456789abcdef0123456789abcdef");
      expect(section.enabled).toBe(true);
    });

    it("shows intro and next-steps notes", async () => {
      const prompter = makePrompter({
        text: vi.fn().mockResolvedValueOnce("12345").mockResolvedValueOnce("abc123hash"),
      });

      await telegramUserbotOnboardingAdapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      expect(prompter.note).toHaveBeenCalledTimes(2);
      // First note: intro with my.telegram.org instructions
      expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
        "my.telegram.org",
      );
      // Second note: next steps
      expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("gateway");
    });

    it("preserves existing config when adding credentials", async () => {
      const prompter = makePrompter({
        text: vi.fn().mockResolvedValueOnce("99999").mockResolvedValueOnce("newhash123"),
      });

      const result = await telegramUserbotOnboardingAdapter.configure({
        cfg: makeCfg({ allowFrom: [111, 222], someOtherProp: "keep" }),
        prompter,
        ...defaults,
      });

      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.apiId).toBe(99999);
      expect(section.apiHash).toBe("newhash123");
      expect(section.allowFrom).toEqual([111, 222]);
      expect(section.someOtherProp).toBe("keep");
    });

    it("returns accountId in result", async () => {
      const prompter = makePrompter({
        text: vi.fn().mockResolvedValueOnce("12345").mockResolvedValueOnce("abc123hash"),
      });

      const result = await telegramUserbotOnboardingAdapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      expect(result.accountId).toBe("default");
    });
  });

  describe("disable", () => {
    it("sets enabled to false", () => {
      const result = telegramUserbotOnboardingAdapter.disable!(
        makeCfg({ apiId: 12345, apiHash: "hash", enabled: true }),
      );
      const section = result.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.enabled).toBe(false);
      // preserves credentials
      expect(section.apiId).toBe(12345);
      expect(section.apiHash).toBe("hash");
    });
  });
});
