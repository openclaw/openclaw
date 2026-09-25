import { afterEach, describe, expect, it, vi } from "vitest";
import { listEnabledClickClackAccounts, resolveClickClackAccount } from "./accounts.js";
import type { ClickClackAccountConfig, CoreConfig } from "./types.js";

const selectedEnvId = "CLICKCLACK_SELECTED_TEST_TOKEN";
function createConfig(
  token: ClickClackAccountConfig["token"],
  secrets: CoreConfig["secrets"],
  accountId = "default",
): CoreConfig {
  return {
    secrets,
    channels: {
      clickclack: {
        baseUrl: "https://clickclack.example",
        workspace: "test-workspace",
        ...(accountId === "default"
          ? { token }
          : { token: "lower-priority-root-token", accounts: { [accountId]: { token } } }),
      },
    },
  };
}

describe("ClickClack SecretRef provider policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { accountId: "default", provider: "default", declaration: { source: "file", path: "/unused" } },
    {
      accountId: "work",
      provider: "selected",
      declaration: { source: "exec", command: "/unused" },
    },
  ] as const)(
    "uses injected env when $provider shadows a non-env source for account $accountId",
    ({ accountId, provider, declaration }) => {
      vi.stubEnv(selectedEnvId, "ambient-token-must-not-win");
      const cfg = createConfig(
        { source: "env", provider, id: selectedEnvId },
        {
          defaults: provider === "default" ? undefined : { env: provider },
          providers: { [provider]: declaration },
        },
        accountId,
      );
      expect(
        resolveClickClackAccount({
          cfg,
          accountId,
          env: { [selectedEnvId]: " injected-token " },
        }),
      ).toMatchObject({
        accountId,
        token: "injected-token",
        tokenSource: "config",
        tokenStatus: "available",
        configured: true,
      });
    },
  );

  it.each([
    { name: "unrestricted", allowlist: undefined, allowed: true },
    { name: "matching", allowlist: [selectedEnvId], allowed: true },
    { name: "empty", allowlist: [], allowed: false },
  ])("honors a selected explicit env provider with $name allowlist", ({ allowlist, allowed }) => {
    const cfg = createConfig(
      { source: "env", provider: "selected", id: selectedEnvId },
      {
        defaults: { env: "selected" },
        providers: { selected: { source: "env", allowlist } },
      },
    );
    const resolve = () =>
      resolveClickClackAccount({
        cfg,
        env: { [selectedEnvId]: "injected-token", CLICKCLACK_BOT_TOKEN: "fallback-token" },
      });
    if (allowed) {
      expect(resolve()).toMatchObject({
        token: "injected-token",
        tokenSource: "config",
        tokenStatus: "available",
      });
    } else {
      expect(resolve).toThrow(
        new Error(
          `Environment variable "${selectedEnvId}" is not allowlisted in secrets.providers.selected.allowlist.`,
        ),
      );
    }
  });

  it("rejects a non-default file mismatch with its source diagnostic", () => {
    const cfg = createConfig(
      { source: "env", provider: "other", id: selectedEnvId },
      {
        defaults: { env: "selected" },
        providers: { other: { source: "file", path: "/unused" } },
      },
    );
    expect(() =>
      resolveClickClackAccount({ cfg, env: { [selectedEnvId]: "injected-token" } }),
    ).toThrow(new Error('Secret provider "other" has source "file" but ref requests "env".'));
  });

  it.each(["other", "default"])(
    "rejects undeclared non-selected alias %s with its missing-provider diagnostic",
    (provider) => {
      const cfg = createConfig(
        { source: "env", provider, id: selectedEnvId },
        {
          defaults: { env: "selected" },
        },
      );
      expect(() =>
        resolveClickClackAccount({ cfg, env: { [selectedEnvId]: "injected-token" } }),
      ).toThrow(
        new Error(
          `Secret provider "${provider}" is not configured (ref: env:${provider}:${selectedEnvId}).`,
        ),
      );
    },
  );

  it.each([
    { accountId: "default", declaration: undefined },
    { accountId: "work", declaration: { source: "file", path: "/unused" } },
  ] as const)(
    "keeps missing selected env configured-unavailable without fallback ($accountId)",
    ({ accountId, declaration }) => {
      vi.stubEnv(selectedEnvId, "ambient-token-must-not-win");
      const cfg = createConfig(
        { source: "env", provider: "selected", id: selectedEnvId },
        {
          defaults: { env: "selected" },
          providers: declaration ? { selected: declaration } : undefined,
        },
        accountId,
      );
      expect(
        resolveClickClackAccount({
          cfg,
          accountId,
          env: { CLICKCLACK_BOT_TOKEN: "fallback-token" },
        }),
      ).toMatchObject({
        accountId,
        token: "",
        tokenSource: "config",
        tokenStatus: "configured_unavailable",
        configured: true,
      });
    },
  );

  it("never borrows an env token for a file source ref", () => {
    const cfg = createConfig(
      { source: "file", provider: "default", id: "/selected/token" },
      undefined,
    );
    expect(
      resolveClickClackAccount({
        cfg,
        env: { [selectedEnvId]: "wrong-source-token", CLICKCLACK_BOT_TOKEN: "fallback-token" },
      }),
    ).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      configured: true,
    });
  });

  it("filters disabled accounts while retaining enabled unavailable collision accounts", () => {
    vi.stubEnv(selectedEnvId, "selected-token");
    vi.stubEnv("CLICKCLACK_MISSING_TEST_TOKEN", undefined);
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "fallback-token");
    const tokenRef = { source: "env", provider: "default", id: selectedEnvId } as const;
    const cfg: CoreConfig = {
      secrets: { providers: { default: { source: "file", path: "/unused" } } },
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          workspace: "test-workspace",
          token: tokenRef,
          accounts: {
            work: { token: tokenRef },
            disabled: { token: tokenRef, enabled: false },
            unavailable: { token: { ...tokenRef, id: "CLICKCLACK_MISSING_TEST_TOKEN" } },
          },
        },
      },
    };
    expect(
      listEnabledClickClackAccounts(cfg).map(({ accountId, tokenStatus, token }) => ({
        accountId,
        tokenStatus,
        token,
      })),
    ).toEqual([
      { accountId: "default", tokenStatus: "available", token: "selected-token" },
      { accountId: "unavailable", tokenStatus: "configured_unavailable", token: "" },
      { accountId: "work", tokenStatus: "available", token: "selected-token" },
    ]);
  });
});
