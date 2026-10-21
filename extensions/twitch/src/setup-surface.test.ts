import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../api.js";
import { getAccountConfig } from "./config.js";
import { checkTwitchMessageThroughMonitor } from "./monitor-access.test-support.js";
import {
  configureWithEnvToken,
  promptRefreshTokenSetup,
  promptToken,
  setTwitchAccount,
  twitchSetupPlugin,
  twitchSetupWizard,
} from "./setup-surface.js";
import type { TwitchAccountConfig } from "./types.js";

const mockPromptText = vi.fn<WizardPrompter["text"]>();
const mockPromptConfirm = vi.fn<WizardPrompter["confirm"]>();
const mockPromptNote = vi.fn();
const mockPrompter: WizardPrompter = {
  text: mockPromptText,
  confirm: mockPromptConfirm,
  note: mockPromptNote,
} as unknown as WizardPrompter;

const mockAccount: TwitchAccountConfig = {
  username: "testbot",
  accessToken: "oauth:test123",
  clientId: "test-client-id",
  channel: "#testchannel",
};
const mockRefreshAccount: TwitchAccountConfig = {
  ...mockAccount,
  clientSecret: "existing-secret",
  refreshToken: "existing-refresh",
};

function configuredAccount(id: string): TwitchAccountConfig {
  return {
    username: `${id}-bot`,
    accessToken: `oauth:${id}`,
    clientId: `${id}-client`,
    channel: `#${id}`,
  };
}

type SetupConfig = Parameters<typeof setTwitchAccount>[0];
type TwitchConfig = NonNullable<NonNullable<SetupConfig["channels"]>["twitch"]>;
function configWithAccounts(
  accounts: TwitchConfig["accounts"],
  extra: TwitchConfig = {},
): SetupConfig {
  return { channels: { twitch: { ...extra, accounts } } };
}

function answerText(...answers: string[]) {
  mockPromptText.mockReset();
  for (const answer of answers) {
    mockPromptText.mockResolvedValueOnce(answer);
  }
}

describe("setup surface helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("should return existing token when user confirms to keep it", async () => {
    mockPromptConfirm.mockResolvedValue(true);
    const result = await promptToken(mockPrompter, mockAccount);
    expect(result).toBe("oauth:test123");
    expect(mockPromptConfirm).toHaveBeenCalledWith({
      message: "Access token already configured. Keep it?",
      initialValue: true,
    });
    expect(mockPromptText).not.toHaveBeenCalled();
  });

  it("should use a sensitive prompt when replacing a configured token", async () => {
    mockPromptConfirm.mockResolvedValueOnce(false);
    mockPromptText.mockResolvedValueOnce("oauth:test123");
    const result = await promptToken(mockPrompter, mockAccount);
    const prompt = expectDefined(mockPromptText.mock.calls[0]?.[0], "token prompt");
    expect(mockPromptText).toHaveBeenCalledOnce();
    expect(result).toBe("oauth:test123");
    expect(prompt).toMatchObject({ sensitive: true });
    expect(prompt).not.toHaveProperty("initialValue");
    const capturedValidate = expectDefined(prompt.validate, "token validator");
    expect(capturedValidate("")).toBe("Required");
    expect(capturedValidate("notoauth")).toBe("Token should start with 'oauth:'");
    expect(capturedValidate("oauth:goodtoken")).toBeUndefined();
  });

  it("should prompt for credentials when user accepts", async () => {
    mockPromptConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mockPromptText.mockResolvedValueOnce("secret123").mockResolvedValueOnce("refresh123");
    const result = await promptRefreshTokenSetup(mockPrompter, mockRefreshAccount);
    expect(result).toEqual({ clientSecret: "secret123", refreshToken: "refresh123" });
    for (const index of [0, 1]) {
      expect(mockPromptText.mock.calls[index]?.[0]).toMatchObject({ sensitive: true });
      expect(mockPromptText.mock.calls[index]?.[0]).not.toHaveProperty("initialValue");
    }
  });

  it("should keep existing credentials without opening masked replacement prompts", async () => {
    mockPromptConfirm.mockResolvedValue(true);
    await expect(promptRefreshTokenSetup(mockPrompter, mockRefreshAccount)).resolves.toEqual({
      clientSecret: "existing-secret",
      refreshToken: "existing-refresh",
    });
    expect(mockPromptText).not.toHaveBeenCalled();
  });

  it("skips env-token shortcut for non-default accounts", async () => {
    mockPromptConfirm.mockReset().mockResolvedValue(true);
    answerText("secondary-bot", "secondary-client");
    const result = await configureWithEnvToken(
      {
        channels: {
          twitch: { defaultAccount: "secondary" },
        },
      } as Parameters<typeof configureWithEnvToken>[0],
      mockPrompter,
      null,
      "oauth:fromenv",
      false,
      {} as Parameters<typeof configureWithEnvToken>[5],
    );
    expect(result).toBeNull();
    expect(mockPromptConfirm).not.toHaveBeenCalled();
    expect(mockPromptText).not.toHaveBeenCalled();
  });

  it("reports status for the requested account override", () => {
    const lines = twitchSetupWizard.status?.resolveStatusLines?.({
      cfg: configWithAccounts({
        default: configuredAccount("default"),
        secondary: configuredAccount("secondary"),
      }),
      accountId: "secondary",
      configured: true,
    } as never);
    expect(lines).toEqual(["Twitch (secondary): configured"]);
  });

  it("reports env-token default account setup as configured", async () => {
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "oauth:fromenv");
    const cfg = configWithAccounts({
      default: { username: "env-bot", accessToken: "", clientId: "env-client", channel: "#env" },
    });
    expect(twitchSetupWizard.status?.resolveConfigured({ cfg })).toBe(true);
    const account = twitchSetupPlugin.config.resolveAccount(cfg, "default");
    expect(await twitchSetupPlugin.config.isConfigured?.(account, cfg)).toBe(true);
  });

  type FinalizeArgs = Parameters<NonNullable<typeof twitchSetupWizard.finalize>>[0];

  async function finalizeTwitchSetup(cfg: FinalizeArgs["cfg"], accountId: string) {
    return await twitchSetupWizard.finalize?.({
      cfg,
      accountId,
      credentialValues: {},
      runtime: {} as FinalizeArgs["runtime"],
      prompter: mockPrompter,
      options: {},
      forceAllowFrom: false,
    });
  }

  it("uses an environment-only token without sending it to wizard prompts", async () => {
    const envToken = "oauth:environment-only";
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", envToken);
    mockPromptConfirm.mockReset().mockResolvedValueOnce(true);
    answerText("env-bot", "env-client");
    const result = await finalizeTwitchSetup({}, "default");
    expect(result?.cfg?.channels?.twitch?.accounts?.default).toMatchObject({
      username: "env-bot",
      accessToken: envToken,
      clientId: "env-client",
    });
    expect(mockPromptConfirm).toHaveBeenCalledWith({
      message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
      initialValue: true,
    });
    expect(mockPromptText).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockPromptConfirm.mock.calls)).not.toContain(envToken);
    expect(JSON.stringify(mockPromptText.mock.calls)).not.toContain(envToken);
  });

  it("rejects reserved account ids before using them as config keys", () => {
    expect(() => setTwitchAccount({}, configuredAccount("reserved"), "__proto__")).toThrow(
      "Invalid Twitch account id",
    );
    expect(Object.prototype).not.toHaveProperty("username");
  });

  it("normalizes account ids before rendering status lines", () => {
    expect(
      twitchSetupWizard.status?.resolveStatusLines?.({
        cfg: {},
        accountId: "Alerts\r\n\u001b[31m",
        configured: false,
      } as never),
    ).toEqual(["Twitch (alerts-31m): needs username, token, and clientId"]);
  });

  it.each([
    [{ channels: { twitch: { defaultAccount: "secondary" } } }, undefined, "secondary"],
    [{}, "alerts", "alerts"],
  ] as const)("resolves DM policy keys for %j / %s", (cfg, requested, expected) => {
    expect(twitchSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg, requested)).toEqual({
      policyKey: `channels.twitch.accounts.${expected}.allowedRoles`,
      allowFromKey: `channels.twitch.accounts.${expected}.allowFrom`,
    });
  });

  it("writes to the requested account when defaultAccount is not created yet", async () => {
    answerText("secondary-bot", "oauth:secondary", "secondary-client", "#secondary");
    mockPromptConfirm.mockReset().mockResolvedValue(false);
    const result = await finalizeTwitchSetup(
      configWithAccounts(
        { default: configuredAccount("default") },
        { defaultAccount: "secondary" },
      ),
      "secondary",
    );
    const twitch = result?.cfg?.channels?.twitch;
    expect(twitch?.accounts).toMatchObject({
      secondary: { username: "secondary-bot", accessToken: "oauth:secondary" },
      default: { username: "default-bot" },
    });
    const validate = expectDefined(mockPromptText.mock.calls[3]?.[0].validate, "channel validator");
    expect(validate("")).toBe("Required");
    expect(validate("   ")).toBe("Required");
    expect(validate("#chan")).toBeUndefined();
  });

  it("persists a token instead of using env-token shortcut for non-default finalize", async () => {
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "oauth:fromenv");
    answerText("secondary-bot", "oauth:persisted", "secondary-client", "#secondary");
    mockPromptConfirm.mockReset().mockResolvedValue(false);
    const result = await finalizeTwitchSetup(configWithAccounts({}), "secondary");
    const twitch = result?.cfg?.channels?.twitch;
    expect(twitch?.accounts?.secondary?.accessToken).toBe("oauth:persisted");
    expect(mockPromptConfirm).toHaveBeenCalledTimes(1);
    expect(mockPromptConfirm).toHaveBeenCalledWith({
      message: "Enable automatic token refresh (requires client secret and refresh token)?",
      initialValue: false,
    });
  });

  const groupAccess = expectDefined(twitchSetupWizard.groupAccess, "group access setup");

  it("updates the whitespace-username base account without mutating other accounts", () => {
    const account = { ...mockAccount, enabled: false, allowFrom: ["123456"] };
    const cfg = {
      channels: {
        twitch: {
          ...account,
          username: " ",
          accounts: { default: account, secondary: account, untouched: mockRefreshAccount },
        },
      },
    };
    const before = structuredClone(cfg);
    const patch = { allowFrom: [], allowedRoles: [], requireMention: true };
    const result = groupAccess.setPolicy({ cfg, accountId: "default", policy: "disabled" });
    expect(result).toEqual({
      channels: {
        twitch: {
          ...cfg.channels.twitch,
          enabled: true,
          ...patch,
        },
      },
    });
    expect(getAccountConfig(result, "default")).toMatchObject(patch);
    expect(cfg).toEqual(before);
  });

  it("does not create a missing account", () => {
    const cfg = {};
    expect(groupAccess.setPolicy({ cfg, accountId: "missing", policy: "disabled" })).toBe(cfg);
  });

  it.each([
    ["base disabled to open", "default", [], ["open"], false, undefined, true],
    ["IDs to disabled", "secondary", ["123456"], ["disabled"], false, [], false],
    ["IDs precede roles", "secondary", ["other"], ["allowlist"], true, ["other"], false],
    [
      "disabled does not restore IDs",
      "secondary",
      ["123456"],
      ["disabled", "allowlist"],
      false,
      undefined,
      false,
    ],
  ] as const)(
    "applies %s through real ingress",
    async (_name, accountId, allowFrom, policies, isMod, expectedAllowFrom, allowed) => {
      const initialAccount: TwitchAccountConfig = {
        ...mockAccount,
        enabled: true,
        allowFrom: allowFrom ? [...allowFrom] : undefined,
        allowedRoles: ["all"],
      };
      let cfg: Parameters<typeof groupAccess.setPolicy>[0]["cfg"] = {
        channels: {
          twitch:
            accountId === "default" ? initialAccount : { accounts: { secondary: initialAccount } },
        },
      };
      for (const policy of policies) {
        cfg = groupAccess.setPolicy({ cfg, accountId, policy });
      }
      const account = expectDefined(getAccountConfig(cfg, accountId), "configured account");
      expect(account.allowFrom).toEqual(expectedAllowFrom);
      expect(groupAccess.currentPolicy({ cfg, accountId })).toBe(policies.at(-1));
      expect(groupAccess.updatePrompt?.({ cfg, accountId })).toBe(true);
      const result = await checkTwitchMessageThroughMonitor({
        account,
        accountId,
        message: {
          id: "policy-transition-message",
          userId: "123456",
          username: "viewer",
          message: "@testbot hello",
          channel: mockAccount.channel,
          isMod,
        },
      });
      expect(result.allowed).toBe(allowed);
    },
  );

  it("reports empty roles as open without prompting for an update", () => {
    const cfg = configWithAccounts({ secondary: { ...mockAccount, allowedRoles: [] } });
    expect(groupAccess.currentPolicy({ cfg, accountId: "secondary" })).toBe("open");
    expect(groupAccess.updatePrompt?.({ cfg, accountId: "secondary" })).toBe(false);
  });
});
