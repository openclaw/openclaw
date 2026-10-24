import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../api.js";
import { getAccountConfig } from "./config.js";
import { checkTwitchMessageThroughMonitor } from "./monitor-access.test-support.js";
import { setTwitchAccount, twitchSetupPlugin, twitchSetupWizard } from "./setup-surface.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

const mockPromptText = vi.fn<WizardPrompter["text"]>();
const mockPromptConfirm = vi.fn<WizardPrompter["confirm"]>();
const mockPrompter: WizardPrompter = {
  text: mockPromptText,
  confirm: mockPromptConfirm,
  note: vi.fn(),
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
const defaultConfig = configWithAccounts({ default: mockAccount });
const refreshConfig = configWithAccounts({ default: mockRefreshAccount });

function configuredAccount(id: string): TwitchAccountConfig {
  return {
    username: `${id}-bot`,
    accessToken: `oauth:${id}`,
    clientId: `${id}-client`,
    channel: `#${id}`,
  };
}

function checkAccess(
  account: TwitchAccountConfig,
  message: Partial<TwitchChatMessage> = {},
  accountId = "secondary",
) {
  return checkTwitchMessageThroughMonitor({
    account,
    accountId,
    message: {
      id: "message-1",
      username: "testuser",
      userId: "123456",
      message: "@testbot hello",
      channel: account.channel,
      ...message,
    },
  });
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

function answerConfirm(...answers: boolean[]) {
  mockPromptConfirm.mockReset();
  for (const answer of answers) {
    mockPromptConfirm.mockResolvedValueOnce(answer);
  }
}

function expectSensitivePrompt(index: number) {
  const prompt = expectDefined(mockPromptText.mock.calls[index]?.[0], "sensitive prompt");
  expect(prompt).toMatchObject({ sensitive: true });
  expect(prompt).not.toHaveProperty("initialValue");
  return prompt;
}

describe("setup surface helpers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    "keeps existing credentials (refresh: %s) without masked prompts",
    async (refresh) => {
      mockPromptConfirm.mockReset().mockResolvedValue(refresh);
      if (!refresh) {
        answerConfirm(true, false);
      }
      answerText("testbot", "test-client-id", "#testchannel");
      const result = await finalizeTwitchSetup(refresh ? refreshConfig : defaultConfig);
      expect(result?.default).toMatchObject(refresh ? mockRefreshAccount : mockAccount);
      expect(mockPromptConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ initialValue: true }),
      );
      expect(mockPromptText).toHaveBeenCalledTimes(3);
      expect(mockPromptText.mock.calls.some(([prompt]) => prompt.sensitive)).toBe(false);
    },
  );

  it("should use a sensitive prompt when replacing a configured token", async () => {
    mockPromptConfirm.mockReset().mockResolvedValue(false);
    answerText("testbot", "oauth:test123", "test-client-id", "#testchannel");
    const result = await finalizeTwitchSetup(defaultConfig);
    const prompt = expectSensitivePrompt(1);
    expect(mockPromptText).toHaveBeenCalledTimes(4);
    expect(result?.default?.accessToken).toBe("oauth:test123");
    const capturedValidate = expectDefined(prompt.validate, "token validator");
    expect(capturedValidate("")).toBe("Required");
    expect(capturedValidate("notoauth")).toBe("Token should start with 'oauth:'");
    expect(capturedValidate("oauth:goodtoken")).toBeUndefined();
  });

  it("should prompt for credentials when user accepts", async () => {
    answerConfirm(true, true, false, false);
    answerText("testbot", "test-client-id", "#testchannel", "secret123", "refresh123");
    const result = await finalizeTwitchSetup(refreshConfig);
    expect(result?.default).toMatchObject({
      clientSecret: "secret123",
      refreshToken: "refresh123",
    });
    for (const index of [3, 4]) {
      expectSensitivePrompt(index);
    }
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

  async function finalizeTwitchSetup(cfg: FinalizeArgs["cfg"], accountId = "default") {
    const result = await twitchSetupWizard.finalize?.({
      cfg,
      accountId,
      credentialValues: {},
      runtime: {} as FinalizeArgs["runtime"],
      prompter: mockPrompter,
      options: {},
      forceAllowFrom: false,
    });
    return result?.cfg?.channels?.twitch?.accounts;
  }

  it("uses an environment-only token without sending it to wizard prompts", async () => {
    const envToken = "oauth:environment-only";
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", envToken);
    mockPromptConfirm.mockReset().mockResolvedValueOnce(true);
    answerText("env-bot", "env-client");
    const result = await finalizeTwitchSetup({}, "default");
    expect(result?.default).toMatchObject({
      username: "env-bot",
      accessToken: envToken,
      clientId: "env-client",
    });
    expect(mockPromptConfirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
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
    expect(result).toMatchObject({
      secondary: { username: "secondary-bot", accessToken: "oauth:secondary" },
      default: { username: "default-bot" },
    });
    const validate = expectDefined(mockPromptText.mock.calls[3]?.[0].validate, "channel validator");
    expect(["", "   ", "#chan"].map(validate)).toEqual(["Required", "Required", undefined]);
  });

  it("persists a token instead of using env-token shortcut for non-default finalize", async () => {
    vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "oauth:fromenv");
    answerText("secondary-bot", "oauth:persisted", "secondary-client", "#secondary");
    mockPromptConfirm.mockReset().mockResolvedValue(false);
    const result = await finalizeTwitchSetup(configWithAccounts({}), "secondary");
    expect(result?.secondary?.accessToken).toBe("oauth:persisted");
    expect(mockPromptConfirm).toHaveBeenCalledTimes(1);
    expect(mockPromptConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false }),
    );
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
      channels: { twitch: { ...cfg.channels.twitch, enabled: true, ...patch } },
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
      const result = await checkAccess(account, { isMod }, accountId);
      expect(result.allowed).toBe(allowed);
    },
  );

  it("reports empty roles as open without prompting for an update", () => {
    const cfg = configWithAccounts({ secondary: { ...mockAccount, allowedRoles: [] } });
    expect(groupAccess.currentPolicy({ cfg, accountId: "secondary" })).toBe("open");
    expect(groupAccess.updatePrompt?.({ cfg, accountId: "secondary" })).toBe(false);
  });
});

describe("Twitch monitor access control", () => {
  it.each<[string, Partial<TwitchAccountConfig>, Partial<TwitchChatMessage>, boolean]>([
    ["requires mention by default", {}, { message: "hello bot" }, false],
    ["blocks missing allowlisted ID", { allowFrom: ["123456"] }, { userId: undefined }, false],
    ["allows wildcard roles without ID", { allowedRoles: ["all"] }, { userId: undefined }, true],
    [
      "does not confuse IDs with roles",
      { allowedRoles: ["moderator"] },
      { userId: "moderator" },
      false,
    ],
    ["keeps empty roles open", { allowedRoles: [] }, { userId: undefined }, true],
    [
      "blocks unmentioned unauthorized chat",
      { requireMention: true, allowedRoles: ["moderator"] },
      { message: "ordinary chat", isMod: false },
      false,
    ],
    [
      "checks allowlist before roles",
      { allowFrom: ["123456"], allowedRoles: ["owner"] },
      { isOwner: false },
      true,
    ],
  ])("%s", async (_name, account, message, allowed) => {
    expect((await checkAccess({ ...mockAccount, ...account }, message)).allowed).toBe(allowed);
  });

  it.each([
    { role: "moderator", flag: "isMod" },
    { role: "owner", flag: "isOwner" },
    { role: "vip", flag: "isVip" },
    { role: "subscriber", flag: "isSub" },
  ] as const)(
    "admits only the matching $role alias, including absent native IDs",
    async ({ role, flag }) => {
      for (const userId of ["123456", undefined]) {
        for (const matching of [false, true]) {
          const result = await checkAccess(
            { ...mockAccount, allowedRoles: [role] },
            { userId, [flag]: matching },
          );
          expect(result.allowed).toBe(matching);
        }
      }
    },
  );
});
