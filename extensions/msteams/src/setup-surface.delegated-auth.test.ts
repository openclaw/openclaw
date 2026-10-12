import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsSetupWizard } from "./setup-surface.js";

const hasConfiguredMSTeamsCredentials = vi.hoisted(() => vi.fn());
const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());
const saveDelegatedTokens = vi.hoisted(() => vi.fn());
const loginMSTeamsDelegated = vi.hoisted(() => vi.fn());
const oauthModuleState = vi.hoisted(() => ({ loaded: false }));

vi.mock("./token-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-config.js")>()),
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
}));

vi.mock("./delegated-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delegated-state.js")>()),
  saveMSTeamsDelegatedTokens: saveDelegatedTokens,
}));

vi.mock("./oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./oauth.js")>();
  oauthModuleState.loaded = true;
  return { ...actual, loginMSTeamsDelegated };
});

describe("msteams setup delegated auth", () => {
  beforeEach(() => {
    hasConfiguredMSTeamsCredentials.mockReset();
    resolveMSTeamsCredentials.mockReset();
    saveDelegatedTokens.mockReset().mockResolvedValue(undefined);
    loginMSTeamsDelegated.mockReset();
  });

  it("revalidates before delegated OAuth and immediately before saving tokens", async () => {
    const tokens = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["User.Read"],
    };
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue(tokens);
    expect(oauthModuleState.loaded).toBe(false);
    const beforePersistentEffect = vi.fn(async () => {
      expect(oauthModuleState.loaded).toBe(true);
    });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const writing = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    saveDelegatedTokens.mockImplementationOnce(async () => {
      writing.resolve();
      await releaseWrite.promise;
    });

    const configured = msteamsSetupWizard.finalize?.({
      cfg: { channels: { msteams: {} } },
      prompter: {
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
      options: { beforePersistentEffect },
    } as never);

    try {
      await writing.promise;
      expect(progress.stop).not.toHaveBeenCalled();
    } finally {
      releaseWrite.resolve();
      await configured;
    }
    expect(progress.stop).toHaveBeenCalledWith(expect.any(String));
    expect(beforePersistentEffect).toHaveBeenCalledTimes(2);
    expect(loginMSTeamsDelegated).toHaveBeenCalledTimes(1);
    expect(saveDelegatedTokens).toHaveBeenCalledWith(tokens, DEFAULT_ACCOUNT_ID);
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      loginMSTeamsDelegated.mock.invocationCallOrder[0]!,
    );
    expect(loginMSTeamsDelegated.mock.invocationCallOrder[0]).toBeLessThan(
      beforePersistentEffect.mock.invocationCallOrder[1]!,
    );
    expect(beforePersistentEffect.mock.invocationCallOrder[1]).toBeLessThan(
      saveDelegatedTokens.mock.invocationCallOrder[0]!,
    );
  });

  it("propagates a stale inference guard instead of treating it as an OAuth failure", async () => {
    const guardError = new Error("verified inference changed");
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["User.Read"],
    });
    const beforePersistentEffect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(guardError);
    const note = vi.fn(async () => {});
    const progress = { update: vi.fn(), stop: vi.fn() };

    await expect(
      msteamsSetupWizard.finalize?.({
        cfg: { channels: { msteams: {} } },
        prompter: {
          confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true),
          note,
          progress: vi.fn(() => progress),
          text: vi.fn(),
        },
        options: { beforePersistentEffect },
      } as never),
    ).rejects.toBe(guardError);

    expect(loginMSTeamsDelegated).toHaveBeenCalledTimes(1);
    expect(saveDelegatedTokens).not.toHaveBeenCalled();
    expect(progress.stop).toHaveBeenCalledWith();
    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("Delegated auth setup failed"),
      expect.anything(),
    );
  });

  it("stores delegated auth under the resolved named account", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
      scopes: ["ChatMessage.Send"],
    });
    const progress = { update: vi.fn(), stop: vi.fn() };

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: {
                appId: "support-app",
                appPassword: "support-password",
                tenantId: "tenant-id",
                webhook: { path: "/hooks/3979" },
              },
            },
          },
        },
      },
      accountId: "support",
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
    } as never);

    expect(result?.cfg?.channels?.msteams?.accounts?.support).toEqual({
      appId: "support-app",
      appPassword: "support-password",
      tenantId: "tenant-id",
      webhook: { path: "/hooks/3979" },
      delegatedAuth: { enabled: true },
      enabled: true,
    });
    expect(saveDelegatedTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
      "support",
    );
    expect(progress.stop).toHaveBeenCalled();
  });

  it("stores delegated auth under an explicit default account", async () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "secret",
      appId: "default-app",
      appPassword: "default-password",
      tenantId: "tenant-id",
    });
    hasConfiguredMSTeamsCredentials.mockReturnValue(true);
    loginMSTeamsDelegated.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
      scopes: ["ChatMessage.Send"],
    });
    const progress = { update: vi.fn(), stop: vi.fn() };

    const result = await msteamsSetupWizard.finalize?.({
      cfg: {
        channels: {
          msteams: {
            defaultAccount: "Default",
            accounts: {
              Default: {
                appId: "default-app",
                appPassword: "default-password",
                tenantId: "tenant-id",
                webhook: { path: "/hooks/3978" },
              },
            },
          },
        },
      },
      accountId: "default",
      prompter: {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => progress),
        text: vi.fn(),
      },
    } as never);

    expect(result?.cfg?.channels?.msteams?.accounts?.Default).toMatchObject({
      delegatedAuth: { enabled: true },
    });
    expect(result?.cfg?.channels?.msteams?.accounts).not.toHaveProperty("default");
    expect(result?.cfg?.channels?.msteams?.delegatedAuth).toBeUndefined();
    expect(resolveMSTeamsCredentials).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pathPrefix: "channels.msteams.accounts.Default",
      }),
    );
    expect(saveDelegatedTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
      "default",
    );
  });
});
