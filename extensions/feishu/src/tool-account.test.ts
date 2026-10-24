import { describe, expect, it } from "vitest";
import { resolveFeishuToolAccount } from "./tool-account.js";

describe("resolveFeishuToolAccount", () => {
  const requiredTool = { family: "wiki", label: "Wiki" } as const;
  const credentials = (name: string) => ({
    appId: `${name}-app-id`,
    appSecret: `${name}-app-secret`, // pragma: allowlist secret
  });
  const mixedCaseAccounts = () => ({
    Ops: { enabled: true, ...credentials("ops"), tools: { wiki: false } },
    admin: { enabled: true, ...credentials("admin"), tools: { wiki: true } },
  });
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: "ops",
        ...credentials("base"),
        accounts: {
          ops: { ...credentials("ops"), enabled: true },
          work: { ...credentials("work"), enabled: true },
          disabled: { ...credentials("disabled"), enabled: false },
        },
      },
    },
  };

  function resolveAccount(overrides: Partial<Parameters<typeof resolveFeishuToolAccount>[0]> = {}) {
    return resolveFeishuToolAccount({ cfg, requiredTool, ...overrides });
  }
  const config = (overrides: Partial<typeof cfg.channels.feishu>) => ({
    channels: { feishu: { ...cfg.channels.feishu, ...overrides } },
  });

  it("prefers the active contextual account over configured defaultAccount", () => {
    expect(resolveAccount({ defaultAccountId: "work" }).accountId).toBe("work");
  });

  it("matches a mixed-case configured contextual account before fallback", () => {
    expect(() =>
      resolveFeishuToolAccount({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
              accounts: mixedCaseAccounts(),
            },
          },
        },
        defaultAccountId: "ops",
        requiredTool,
      }),
    ).toThrow('Feishu Wiki tools are disabled for account "ops"');
  });

  it("keeps a mixed-case restricted configured default fail-closed", () => {
    expect(() =>
      resolveFeishuToolAccount({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
              defaultAccount: "Ops",
              accounts: mixedCaseAccounts(),
            },
          },
        },
        defaultAccountId: "ops",
        requiredTool,
      }),
    ).toThrow('Feishu Wiki tools are disabled for account "ops"');
  });

  it("falls back to configured defaultAccount when there is no contextual account", () => {
    expect(resolveAccount().accountId).toBe("ops");
  });

  it("skips a disabled configured defaultAccount", () => {
    expect(resolveAccount({ cfg: config({ defaultAccount: "disabled" }) })).toMatchObject({
      accountId: "default",
      appId: "base-app-id",
    });
  });

  it("rejects tool account resolution when the channel is disabled", () => {
    expect(() => resolveAccount({ cfg: config({ enabled: false }) })).toThrow(
      "No usable Feishu account has Wiki tools enabled",
    );
  });

  it("allows an explicit configured account", () => {
    expect(resolveAccount({ executeParams: { accountId: "WORK" } }).accountId).toBe("work");
  });

  it("allows the explicit unlisted default backed by top-level credentials", () => {
    const resolved = resolveAccount({
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "ops",
            ...credentials("base"),
          },
        },
      },
      executeParams: { accountId: "OPS" },
    });

    expect(resolved).toMatchObject({ accountId: "ops", configured: true });
  });

  it.each([
    { name: "malformed", accountId: "!!!", error: "Invalid Feishu account ID" },
    { name: "unknown", accountId: "missing", error: "Unknown Feishu account" },
    { name: "disabled", accountId: "disabled", error: "is disabled" },
  ])("rejects an explicit $name account", (testCase) => {
    expect(() => resolveAccount({ executeParams: { accountId: testCase.accountId } })).toThrow(
      testCase.error,
    );
  });
});
