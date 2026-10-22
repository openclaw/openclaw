import { afterEach, describe, expect, it, vi } from "vitest";
import { listEnabledClickClackAccounts, resolveClickClackAccount } from "./accounts.js";
import type { ClickClackAccountConfig, CoreConfig } from "./types.js";

const selectedEnvId = "CLICKCLACK_SELECTED_TEST_TOKEN";
const selectedRef = { source: "env", provider: "selected", id: selectedEnvId } as const;
const otherRef = { ...selectedRef, provider: "other" };
function secrets(providers?: NonNullable<CoreConfig["secrets"]>["providers"]) {
  return { defaults: { env: "selected" }, providers };
}
function resolve(
  cfg: CoreConfig,
  env: NodeJS.ProcessEnv = { [selectedEnvId]: "injected-token" },
  accountId?: string,
) {
  return resolveClickClackAccount({ cfg, env, accountId });
}
function expectToken(account: ReturnType<typeof resolve>, token: string, accountId?: string) {
  expect(account).toMatchObject({
    ...(accountId ? { accountId } : {}),
    token,
    tokenSource: "config",
    tokenStatus: token ? "available" : "configured_unavailable",
    configured: true,
  });
}
function createConfig(
  token: ClickClackAccountConfig["token"],
  secretConfig: CoreConfig["secrets"],
  accountId = "default",
  accounts: Record<string, ClickClackAccountConfig> | undefined = accountId === "default"
    ? undefined
    : { [accountId]: { token } },
): CoreConfig {
  return {
    secrets: secretConfig,
    channels: {
      clickclack: {
        baseUrl: "https://clickclack.example",
        workspace: "test-workspace",
        token: accountId === "default" ? token : "lower-priority-root-token",
        accounts,
      },
    },
  };
}

describe("ClickClack SecretRef provider policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses injected env when the selected alias shadows a non-env source", () => {
    vi.stubEnv(selectedEnvId, "ambient-token-must-not-win");
    const cfg = createConfig(
      selectedRef,
      secrets({ selected: { source: "exec", command: "/unused" } }),
      "work",
    );
    expectToken(
      resolve(cfg, { [selectedEnvId]: " injected-token " }, "work"),
      "injected-token",
      "work",
    );
  });

  it("rejects a selected explicit env provider with an empty allowlist", () => {
    const cfg = createConfig(selectedRef, secrets({ selected: { source: "env", allowlist: [] } }));
    expect(() =>
      resolve(cfg, { [selectedEnvId]: "injected-token", CLICKCLACK_BOT_TOKEN: "fallback-token" }),
    ).toThrow(
      new Error(
        `Environment variable "${selectedEnvId}" is not allowlisted in secrets.providers.selected.allowlist.`,
      ),
    );
  });

  it("rejects a non-default file mismatch with its source diagnostic", () => {
    const cfg = createConfig(otherRef, secrets({ other: { source: "file", path: "/unused" } }));
    expect(() => resolve(cfg)).toThrow(
      new Error('Secret provider "other" has source "file" but ref requests "env".'),
    );
  });

  it("rejects an undeclared non-selected alias with its missing-provider diagnostic", () => {
    const cfg = createConfig(otherRef, secrets());
    expect(() => resolve(cfg)).toThrow(
      new Error(`Secret provider "other" is not configured (ref: env:other:${selectedEnvId}).`),
    );
  });

  it("keeps missing selected env configured-unavailable without fallback", () => {
    vi.stubEnv(selectedEnvId, "ambient-token-must-not-win");
    const cfg = createConfig(
      selectedRef,
      secrets({ selected: { source: "file", path: "/unused" } }),
      "work",
    );
    expectToken(resolve(cfg, { CLICKCLACK_BOT_TOKEN: "fallback-token" }, "work"), "", "work");
  });

  it("never borrows an env token for a file source ref", () => {
    const cfg = createConfig(
      { source: "file", provider: "default", id: "/selected/token" },
      undefined,
    );
    expectToken(
      resolve(cfg, {
        [selectedEnvId]: "wrong-source-token",
        CLICKCLACK_BOT_TOKEN: "fallback-token",
      }),
      "",
    );
  });

  it("filters disabled accounts while retaining enabled unavailable collision accounts", () => {
    vi.stubEnv(selectedEnvId, "selected-token");
    vi.stubEnv("CLICKCLACK_MISSING_TEST_TOKEN", undefined);
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "fallback-token");
    const tokenRef = { source: "env", provider: "default", id: selectedEnvId } as const;
    const cfg = createConfig(
      tokenRef,
      { providers: { default: { source: "file", path: "/unused" } } },
      "default",
      {
        work: { token: tokenRef },
        disabled: { token: tokenRef, enabled: false },
        unavailable: { token: { ...tokenRef, id: "CLICKCLACK_MISSING_TEST_TOKEN" } },
      },
    );
    expect(listEnabledClickClackAccounts(cfg)).toMatchObject([
      { accountId: "default", tokenStatus: "available", token: "selected-token" },
      { accountId: "unavailable", tokenStatus: "configured_unavailable", token: "" },
      { accountId: "work", tokenStatus: "available", token: "selected-token" },
    ]);
  });
});
