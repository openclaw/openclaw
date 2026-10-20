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
    expect(telegramSetupContract.applyAccountConfig(input).channels?.telegram).toEqual({
      enabled: true,
    });
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
  it.each([
    { name: "explicit named account", dmPolicy: "allowlist", accountId: "alerts" },
    { name: "configured default account", dmPolicy: "pairing", accountId: undefined },
  ] as const)("opens $name without changing root or siblings", ({ dmPolicy, accountId }) => {
    const work = { botToken: "tok-work", dmPolicy: "disabled" as const, allowFrom: ["456"] };
    const next = telegramSetupDmPolicy.setPolicy(
      {
        channels: {
          telegram: {
            defaultAccount: "alerts",
            dmPolicy,
            allowFrom: ["123"],
            accounts: { alerts: { botToken: "tok", dmPolicy: "allowlist" }, work },
          },
        },
      },
      "open",
      accountId,
    );
    expect(next.channels?.telegram?.accounts?.alerts).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["123", "*"],
    });
    expect(next.channels?.telegram?.dmPolicy).toBe(dmPolicy);
    expect(next.channels?.telegram?.allowFrom).toEqual(["123"]);
    expect(next.channels?.telegram?.accounts?.work).toEqual(work);
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
