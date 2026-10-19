import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
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

function teamsConfig(msteams: MSTeamsConfig): OpenClawConfig {
  return { channels: { msteams } };
}

const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
  scopes: ["User.Read"],
};
function credentials(appId = "app-id", appPassword = "app-password") {
  return { type: "secret", appId, appPassword, tenantId: "tenant-id" };
}
function createPrompter(twoConfirmations = false) {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const confirm = twoConfirmations
    ? vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    : vi.fn(async () => true);
  return {
    progress,
    prompter: {
      confirm,
      note: vi.fn(async () => {}),
      progress: vi.fn(() => progress),
      text: vi.fn(),
    },
  };
}
describe("msteams setup delegated auth", () => {
  beforeEach(() => {
    hasConfiguredMSTeamsCredentials.mockReset().mockReturnValue(true);
    resolveMSTeamsCredentials.mockReset().mockReturnValue(credentials());
    saveDelegatedTokens.mockReset().mockResolvedValue(undefined);
    loginMSTeamsDelegated.mockReset().mockResolvedValue(tokens);
  });

  it("revalidates before delegated OAuth and immediately before saving tokens", async () => {
    expect(oauthModuleState.loaded).toBe(false);
    const beforePersistentEffect = vi.fn(async () => {
      expect(oauthModuleState.loaded).toBe(true);
    });
    const { prompter, progress } = createPrompter(true);
    const writing = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    saveDelegatedTokens.mockImplementationOnce(async () => {
      writing.resolve();
      await releaseWrite.promise;
    });

    const configured = msteamsSetupWizard.finalize?.({
      cfg: teamsConfig({}),
      prompter,
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
    const beforePersistentEffect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(guardError);
    const { prompter, progress } = createPrompter(true);
    const { note } = prompter;

    await expect(
      msteamsSetupWizard.finalize?.({
        cfg: teamsConfig({}),
        prompter,
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

  it.each([
    ["support", "support", "/hooks/3979"],
    ["default", "Default", "/hooks/3978"],
  ] as const)("stores delegated auth under account %s", async (accountId, key, path) => {
    const account = {
      appId: `${accountId}-app`,
      appPassword: `${accountId}-password`,
      tenantId: "tenant-id",
      webhook: { path },
    };
    resolveMSTeamsCredentials.mockReturnValue({ type: "secret", ...account });
    loginMSTeamsDelegated.mockResolvedValue({ ...tokens, scopes: ["ChatMessage.Send"] });
    const { prompter, progress } = createPrompter();
    const result = await msteamsSetupWizard.finalize?.({
      cfg: teamsConfig({
        ...(accountId === "default" ? { defaultAccount: key } : {}),
        accounts: { [key]: account },
      }),
      accountId,
      prompter,
    } as never);
    const configured = result?.cfg?.channels?.msteams;
    if (accountId === "support") {
      expect(configured?.accounts?.support).toEqual({
        appId: "support-app",
        appPassword: "support-password",
        tenantId: "tenant-id",
        webhook: { path: "/hooks/3979" },
        delegatedAuth: { enabled: true },
        enabled: true,
      });
      expect(progress.stop).toHaveBeenCalled();
    } else {
      expect(configured?.accounts?.Default).toMatchObject({ delegatedAuth: { enabled: true } });
      expect(configured?.accounts).not.toHaveProperty("default");
      expect(configured?.delegatedAuth).toBeUndefined();
      expect(resolveMSTeamsCredentials).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ pathPrefix: "channels.msteams.accounts.Default" }),
      );
    }
    expect(saveDelegatedTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "access-token", refreshToken: "refresh-token" }),
      accountId,
    );
  });
});
