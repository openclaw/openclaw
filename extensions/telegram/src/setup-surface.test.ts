// Telegram tests cover setup surface plugin behavior.
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { telegramSetupContract } from "./setup-core.js";
import { telegramSetupDmPolicy } from "./setup-surface.helpers.js";
import { telegramSetupWizard } from "./setup-surface.js";

describe("Telegram environment setup", () => {
  it("enables environment credentials without authoring an inline or file token", () => {
    const input = {
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: { useEnv: true },
    };
    expect(telegramSetupContract.validateInput?.(input)).toBeNull();
    const cfg = telegramSetupContract.applyAccountConfig(input);
    expect(cfg.channels?.telegram).toEqual({ enabled: true });
    expect(cfg.channels?.telegram?.botToken).toBeUndefined();
    expect(cfg.channels?.telegram?.tokenFile).toBeUndefined();
  });
});

describe("telegramSetupWizard preparation", () => {
  it.each([
    { authored: undefined, expected: true },
    { authored: false, expected: false },
  ])("prepares wildcard mention gating with authored=$authored", async ({ authored, expected }) => {
    const result = await telegramSetupWizard.prepare?.({
      cfg: {
        channels: {
          telegram: {
            botToken: "tok",
            ...(authored !== undefined ? { groups: { "*": { requireMention: authored } } } : {}),
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
      credentialValues: {},
      runtime: createRuntimeSpies(),
      prompter: createTestWizardPrompter(),
    });

    expect(result?.cfg?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(expected);
  });
});

describe("telegramSetupDmPolicy", () => {
  it("opens a named account with inherited root allowFrom", () => {
    const next = telegramSetupDmPolicy.setPolicy(
      {
        channels: {
          telegram: {
            dmPolicy: "allowlist",
            allowFrom: ["123"],
            accounts: { alerts: { botToken: "tok" } },
          },
        },
      },
      "open",
      "alerts",
    );
    expect(next.channels?.telegram?.accounts?.alerts).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["123", "*"],
    });
    expect(next.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(next.channels?.telegram?.allowFrom).toEqual(["123"]);
  });

  it("writes omitted-account policy to the configured default without changing root or siblings", () => {
    const next = telegramSetupDmPolicy.setPolicy(
      {
        channels: {
          telegram: {
            defaultAccount: "alerts",
            dmPolicy: "pairing",
            allowFrom: ["123"],
            accounts: {
              alerts: { botToken: "tok-alerts", dmPolicy: "allowlist" },
              work: { botToken: "tok-work", dmPolicy: "disabled", allowFrom: ["456"] },
            },
          },
        },
      },
      "open",
    );
    expect(next.channels?.telegram?.accounts?.alerts).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["123", "*"],
    });
    expect(next.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(next.channels?.telegram?.allowFrom).toEqual(["123"]);
    expect(next.channels?.telegram?.accounts?.work).toEqual({
      botToken: "tok-work",
      dmPolicy: "disabled",
      allowFrom: ["456"],
    });
  });
});

describe("telegramSetupWizard allowFrom", () => {
  it("accepts numeric sender ids only", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    vi.stubGlobal("fetch", globalFetch);

    try {
      const resolved = await telegramSetupWizard.allowFrom?.resolveEntries({
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        credentialValues: { token: "tok" },
        entries: ["@user"],
      });

      expect(resolved).toEqual([{ input: "@user", resolved: false, id: null }]);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
