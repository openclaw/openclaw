import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../api.js";
import { checkTwitchAccessControl } from "./access-control.js";
import { getAccountConfig } from "./config.js";
import { setTwitchRuntime } from "./runtime.js";
import {
  configureWithEnvToken,
  promptChannelName,
  promptRefreshTokenSetup,
  promptToken,
  setTwitchAccount,
  twitchSetupPlugin,
  twitchSetupWizard,
} from "./setup-surface.js";
import type { TwitchAccountConfig } from "./types.js";

// Mock the helpers we're testing
const mockPromptText = vi.fn();
const mockPromptConfirm = vi.fn();
const mockPromptNote = vi.fn();
const mockPrompter: WizardPrompter = {
  text: mockPromptText,
  confirm: mockPromptConfirm,
  note: mockPromptNote,
} as unknown as WizardPrompter;
const originalEnvToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN;

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

function requireFirstTextPromptArgs(): {
  message?: string;
  initialValue?: string;
  sensitive?: boolean;
  validate?: (value: string) => string | undefined;
} {
  const [call] = mockPromptText.mock.calls;
  if (!call || typeof call[0] !== "object" || call[0] === null || Array.isArray(call[0])) {
    throw new Error("expected Twitch text prompt args");
  }
  return call[0] as {
    message?: string;
    initialValue?: string;
    sensitive?: boolean;
    validate?: (value: string) => string | undefined;
  };
}

describe("setup surface helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.OPENCLAW_TWITCH_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = originalEnvToken;
    }
    // Don't restoreAllMocks as it breaks module-level mocks
  });

  describe("promptToken", () => {
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
      const prompt = requireFirstTextPromptArgs();

      expect(mockPromptText).toHaveBeenCalledOnce();
      expect(result).toBe("oauth:test123");
      expect(prompt).toMatchObject({ sensitive: true });
      expect(prompt).not.toHaveProperty("initialValue");
      const capturedValidate = prompt.validate;
      if (!capturedValidate) {
        throw new Error("promptToken validate callback was not captured");
      }
      expect(capturedValidate("")).toBe("Required");
      expect(capturedValidate("notoauth")).toBe("Token should start with 'oauth:'");
      expect(capturedValidate("oauth:goodtoken")).toBeUndefined();
    });
  });

  describe("promptChannelName", () => {
    it("should require a non-empty channel name", async () => {
      mockPromptText.mockResolvedValue("");

      await promptChannelName(mockPrompter, null);

      const { validate } = requireFirstTextPromptArgs();
      expect(validate?.("")).toBe("Required");
      expect(validate?.("   ")).toBe("Required");
      expect(validate?.("#chan")).toBeUndefined();
    });
  });

  describe("promptRefreshTokenSetup", () => {
    it("should prompt for credentials when user accepts", async () => {
      mockPromptConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      mockPromptText.mockResolvedValueOnce("secret123").mockResolvedValueOnce("refresh123");

      const result = await promptRefreshTokenSetup(mockPrompter, mockRefreshAccount);

      expect(result).toEqual({
        clientSecret: "secret123",
        refreshToken: "refresh123",
      });
      expect(mockPromptText).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sensitive: true,
        }),
      );
      expect(mockPromptText.mock.calls[0]?.[0]).not.toHaveProperty("initialValue");
      expect(mockPromptText).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sensitive: true,
        }),
      );
      expect(mockPromptText.mock.calls[1]?.[0]).not.toHaveProperty("initialValue");
    });

    it("should keep existing credentials without opening masked replacement prompts", async () => {
      mockPromptConfirm.mockResolvedValue(true);

      await expect(promptRefreshTokenSetup(mockPrompter, mockRefreshAccount)).resolves.toEqual({
        clientSecret: "existing-secret",
        refreshToken: "existing-refresh",
      });
      expect(mockPromptText).not.toHaveBeenCalled();
    });
  });

  describe("configureWithEnvToken", () => {
    it("skips env-token shortcut for non-default accounts", async () => {
      mockPromptConfirm.mockReset().mockResolvedValue(true as never);
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("secondary-bot" as never)
        .mockResolvedValueOnce("secondary-client" as never);

      const result = await configureWithEnvToken(
        {
          channels: {
            twitch: {
              defaultAccount: "secondary",
            },
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
  });

  describe("defaultAccount setup resolution", () => {
    it("reports status for the configured default account", () => {
      const lines = twitchSetupWizard.status?.resolveStatusLines?.({
        cfg: {
          channels: {
            twitch: {
              defaultAccount: "secondary",
              accounts: {
                secondary: configuredAccount("secondary"),
              },
            },
          },
        },
      } as never);

      expect(lines).toEqual(["Twitch (secondary): configured"]);
    });

    it("reports status for the requested account override", () => {
      const lines = twitchSetupWizard.status?.resolveStatusLines?.({
        cfg: {
          channels: {
            twitch: {
              accounts: {
                default: configuredAccount("default"),
                secondary: configuredAccount("secondary"),
              },
            },
          },
        },
        accountId: "secondary",
        configured: true,
      } as never);

      expect(lines).toEqual(["Twitch (secondary): configured"]);
    });

    it("reports env-token default account setup as configured", async () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:fromenv";

      const cfg = {
        channels: {
          twitch: {
            accounts: {
              default: {
                username: "env-bot",
                accessToken: "",
                clientId: "env-client",
                channel: "#env",
              },
            },
          },
        },
      } as Parameters<NonNullable<typeof twitchSetupWizard.status>["resolveConfigured"]>[0]["cfg"];

      expect(twitchSetupWizard.status?.resolveConfigured({ cfg })).toBe(true);
      const account = twitchSetupPlugin.config.resolveAccount(cfg, "default");
      expect(await twitchSetupPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    });
  });

  describe("setup wizard account routing", () => {
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

    it("blocks mentioned chat after the setup wizard disables group access", async () => {
      setTwitchRuntime(createPluginRuntimeMock());
      const groupAccess = twitchSetupWizard.groupAccess;
      if (!groupAccess) {
        throw new Error("expected Twitch group access setup");
      }
      const cfg = groupAccess.setPolicy({
        cfg: {
          channels: {
            twitch: {
              enabled: true,
              accounts: {
                secondary: { ...mockAccount, enabled: true },
              },
            },
          },
        },
        accountId: "secondary",
        policy: "disabled",
      });
      const account = getAccountConfig(cfg, "secondary");
      if (!account) {
        throw new Error("expected configured Twitch account");
      }
      expect(account.enabled).toBe(true);

      const result = await checkTwitchAccessControl({
        account,
        accountId: "secondary",
        botUsername: mockAccount.username,
        message: {
          id: "disabled-group-message",
          userId: "123456",
          username: "viewer",
          message: "@testbot hello",
          channel: mockAccount.channel,
          isMod: false,
          isOwner: false,
          isVip: false,
          isSub: false,
        },
      });

      expect(result.allowed).toBe(false);
    });

    it("uses an environment-only token without sending it to wizard prompts", async () => {
      const envToken = "oauth:environment-only";
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = envToken;
      mockPromptConfirm.mockReset().mockResolvedValueOnce(true as never);
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("env-bot" as never)
        .mockResolvedValueOnce("env-client" as never);

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
      expect(() =>
        setTwitchAccount(
          {} as Parameters<typeof setTwitchAccount>[0],
          {
            username: "reserved-bot",
            accessToken: "oauth:reserved",
            clientId: "reserved-client",
            channel: "#reserved",
          },
          "__proto__",
        ),
      ).toThrow("Invalid Twitch account id");

      expect(Object.prototype).not.toHaveProperty("username");
    });

    it("rejects reserved account ids before env-token writes", async () => {
      await expect(
        configureWithEnvToken(
          {} as Parameters<typeof configureWithEnvToken>[0],
          mockPrompter,
          null,
          "oauth:fromenv",
          false,
          {} as Parameters<typeof configureWithEnvToken>[5],
          "__proto__",
        ),
      ).rejects.toThrow("Invalid Twitch account id");

      expect(mockPromptConfirm).not.toHaveBeenCalled();
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

    it("reports account-scoped DM policy config keys", () => {
      expect(
        twitchSetupWizard.dmPolicy?.resolveConfigKeys?.(
          {
            channels: {
              twitch: {
                defaultAccount: "secondary",
              },
            },
          } as Parameters<
            NonNullable<NonNullable<typeof twitchSetupWizard.dmPolicy>["resolveConfigKeys"]>
          >[0],
          undefined,
        ),
      ).toEqual({
        policyKey: "channels.twitch.accounts.secondary.allowedRoles",
        allowFromKey: "channels.twitch.accounts.secondary.allowFrom",
      });

      expect(twitchSetupWizard.dmPolicy?.resolveConfigKeys?.({} as never, "alerts")).toEqual({
        policyKey: "channels.twitch.accounts.alerts.allowedRoles",
        allowFromKey: "channels.twitch.accounts.alerts.allowFrom",
      });
    });

    it("writes to the requested account when defaultAccount is not created yet", async () => {
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("secondary-bot" as never)
        .mockResolvedValueOnce("oauth:secondary" as never)
        .mockResolvedValueOnce("secondary-client" as never)
        .mockResolvedValueOnce("#secondary" as never);
      mockPromptConfirm.mockReset().mockResolvedValue(false as never);

      const result = await finalizeTwitchSetup(
        {
          channels: {
            twitch: {
              defaultAccount: "secondary",
              accounts: {
                default: configuredAccount("default"),
              },
            },
          },
        } as FinalizeArgs["cfg"],
        "secondary",
      );

      const twitch = result?.cfg?.channels?.twitch;
      expect(twitch?.accounts?.secondary?.username).toBe("secondary-bot");
      expect(twitch?.accounts?.secondary?.accessToken).toBe("oauth:secondary");
      expect(twitch?.accounts?.default?.username).toBe("default-bot");
    });

    it("persists a token instead of using env-token shortcut for non-default finalize", async () => {
      process.env.OPENCLAW_TWITCH_ACCESS_TOKEN = "oauth:fromenv";
      mockPromptText
        .mockReset()
        .mockResolvedValueOnce("secondary-bot" as never)
        .mockResolvedValueOnce("oauth:persisted" as never)
        .mockResolvedValueOnce("secondary-client" as never)
        .mockResolvedValueOnce("#secondary" as never);
      mockPromptConfirm.mockReset().mockResolvedValue(false as never);

      const result = await finalizeTwitchSetup(
        {
          channels: {
            twitch: {
              accounts: {},
            },
          },
        } as FinalizeArgs["cfg"],
        "secondary",
      );

      const twitch = result?.cfg?.channels?.twitch;
      expect(twitch?.accounts?.secondary?.accessToken).toBe("oauth:persisted");
      expect(mockPromptConfirm).toHaveBeenCalledTimes(1);
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Enable automatic token refresh (requires client secret and refresh token)?",
        initialValue: false,
      });
    });
  });

  describe("group access policy", () => {
    const groupAccess = twitchSetupWizard.groupAccess;
    if (!groupAccess) {
      throw new Error("expected Twitch group access setup");
    }

    it.each([
      ["named account", "SECONDARY", "basebot", "secondary"],
      ["nested default", "default", undefined, "default"],
      ["empty base username", "default", "", "default"],
      ["base default", "default", "testbot", "base"],
      ["whitespace base username", "default", " ", "base"],
    ] as const)("updates only the reader's %s layout", (_name, accountId, username, target) => {
      const account = { ...mockAccount, enabled: false, allowFrom: ["123456"] };
      const cfg = {
        channels: {
          twitch: {
            ...account,
            username,
            accounts: { default: account, secondary: account, untouched: mockRefreshAccount },
          },
        },
      };
      const before = structuredClone(cfg);
      const patch = { allowFrom: [], allowedRoles: [], requireMention: true };

      const result = groupAccess.setPolicy({ cfg, accountId, policy: "disabled" });

      expect(result).toEqual({
        channels: {
          twitch: {
            ...cfg.channels.twitch,
            enabled: true,
            ...(target === "base"
              ? patch
              : {
                  accounts: {
                    ...cfg.channels.twitch.accounts,
                    [target]: { ...account, ...patch },
                  },
                }),
          },
        },
      });
      expect(getAccountConfig(result, accountId)).toMatchObject(patch);
      expect(cfg).toEqual(before);
    });

    it("does not create a missing account", () => {
      const cfg = {};
      expect(groupAccess.setPolicy({ cfg, accountId: "missing", policy: "disabled" })).toBe(cfg);
    });

    it.each([
      ["base disabled to open", "default", [], ["open"], false, undefined, true],
      ["IDs to open", "secondary", ["other"], ["open"], false, undefined, true],
      ["IDs to disabled", "secondary", ["123456"], ["disabled"], false, [], false],
      ["base disabled to roles", "default", [], ["allowlist"], true, undefined, true],
      ["unset IDs to roles", "secondary", undefined, ["allowlist"], true, undefined, true],
      ["retained matching ID", "secondary", ["123456"], ["allowlist"], false, ["123456"], true],
      ["IDs precede roles", "secondary", ["other"], ["allowlist"], true, ["other"], false],
      [
        "open does not restore IDs",
        "secondary",
        ["123456"],
        ["open", "allowlist"],
        false,
        undefined,
        false,
      ],
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
        setTwitchRuntime(createPluginRuntimeMock());
        const initialAccount: TwitchAccountConfig = {
          ...mockAccount,
          enabled: true,
          allowFrom: allowFrom ? [...allowFrom] : undefined,
          allowedRoles: ["all"],
        };
        let cfg: Parameters<typeof groupAccess.setPolicy>[0]["cfg"] = {
          channels: {
            twitch:
              accountId === "default"
                ? initialAccount
                : { accounts: { secondary: initialAccount } },
          },
        };
        for (const policy of policies) {
          cfg = groupAccess.setPolicy({ cfg, accountId, policy });
        }
        const account = getAccountConfig(cfg, accountId);
        if (!account) {
          throw new Error("expected configured Twitch account");
        }
        expect(account.allowFrom).toEqual(expectedAllowFrom);
        expect(groupAccess.currentPolicy({ cfg, accountId })).toBe(policies.at(-1));
        expect(groupAccess.updatePrompt?.({ cfg, accountId })).toBe(true);
        const result = await checkTwitchAccessControl({
          account,
          accountId,
          botUsername: mockAccount.username,
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

    it.each([
      [[], ["all"], "disabled", true],
      [["123456"], ["all"], "allowlist", true],
      [undefined, ["owner"], "allowlist", true],
      [undefined, ["vip"], "allowlist", true],
      [undefined, ["subscriber"], "allowlist", true],
      [undefined, ["all"], "open", true],
      [undefined, [], "open", false],
      [undefined, undefined, "open", false],
    ] as const)("reports allowFrom=%j roles=%j as %s", (allowFrom, roles, policy, updatePrompt) => {
      const cfg = {
        channels: {
          twitch: {
            accounts: {
              secondary: {
                ...mockAccount,
                allowFrom: allowFrom ? [...allowFrom] : undefined,
                allowedRoles: roles ? [...roles] : undefined,
              },
            },
          },
        },
      };
      expect(groupAccess.currentPolicy({ cfg, accountId: "secondary" })).toBe(policy);
      expect(groupAccess.updatePrompt?.({ cfg, accountId: "secondary" })).toBe(updatePrompt);
    });
  });
});
