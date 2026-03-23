import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";

const resolveMattermostAccount = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const hasConfiguredSecretInput = vi.hoisted(() => vi.fn((value: unknown) => Boolean(value)));

vi.mock("./mattermost/accounts.js", () => ({
  resolveMattermostAccount,
}));

vi.mock("./mattermost/client.js", () => ({
  normalizeMattermostBaseUrl,
}));

vi.mock("./secret-input.js", () => ({
  hasConfiguredSecretInput,
}));

describe("mattermost setup core", () => {
  it("reports configuration only when token and base url are both present", async () => {
    const { isMattermostConfigured } = await import("./setup-core.js");

    expect(
      isMattermostConfigured({
        botToken: "bot-token",
        baseUrl: "https://chat.example.com",
        config: {},
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "https://chat.example.com",
        config: { botToken: "secret-ref" },
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "",
        config: {},
      } as never),
    ).toBe(false);
  });

  it("resolves accounts with unresolved secret refs allowed", async () => {
    resolveMattermostAccount.mockReturnValue({ accountId: "default" });

    const { resolveMattermostAccountWithSecrets } = await import("./setup-core.js");
    const cfg = { channels: { mattermost: {} } };

    expect(resolveMattermostAccountWithSecrets(cfg as never, "default")).toEqual({
      accountId: "default",
    });
    expect(resolveMattermostAccount).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      allowUnresolvedSecretRef: true,
    });
  });

  it("validates env and explicit credential requirements", async () => {
    const { mattermostSetupAdapter } = await import("./setup-core.js");
    const validateInput = mattermostSetupAdapter.validateInput;
    expect(validateInput).toBeTypeOf("function");

    expect(
      validateInput!({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("Mattermost env vars can only be used for the default account.");

    normalizeMattermostBaseUrl.mockReturnValue(undefined);
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "not-a-url" },
      } as never),
    ).toBe("Mattermost requires --bot-token and --http-url (or --use-env).");

    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "https://chat.example.com" },
      } as never),
    ).toBeNull();
  });

  it("applies normalized config for default and named accounts", async () => {
    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    const { mattermostSetupAdapter } = await import("./setup-core.js");
    const applyAccountConfig = mattermostSetupAdapter.applyAccountConfig;
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      applyAccountConfig!({
        cfg: { channels: { mattermost: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          botToken: "tok",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
          name: "Default",
          botToken: "tok",
          baseUrl: "https://chat.example.com",
        },
      },
    });

    expect(
      applyAccountConfig!({
        cfg: {
          channels: {
            mattermost: {
              name: "Legacy",
            },
          },
        },
        accountId: "Work Team",
        input: {
          name: "Work",
          botToken: "tok2",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toMatchObject({
      channels: {
        mattermost: {
          accounts: {
            default: { name: "Legacy" },
            "work-team": {
              enabled: true,
              name: "Work",
              botToken: "tok2",
              baseUrl: "https://chat.example.com",
            },
          },
        },
      },
    });
  });
});
