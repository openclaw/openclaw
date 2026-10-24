import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listClickClackAccountIds,
  listEnabledClickClackAccounts,
  resolveClickClackAccount,
} from "./accounts.js";
import type { ClickClackAccountConfig, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const ACCOUNT_BASE = { baseUrl: "https://app.clickclack.chat", workspace: "wsp_1" };
afterEach(() => vi.unstubAllEnvs());
function accountConfig(
  settings: ClickClackAccountConfig & { accounts?: Record<string, ClickClackAccountConfig> },
  secrets?: CoreConfig["secrets"],
): CoreConfig {
  return { secrets, channels: { clickclack: { ...ACCOUNT_BASE, ...settings } } };
}
function resolve(
  settings: Parameters<typeof accountConfig>[0],
  accountId?: string,
  env?: NodeJS.ProcessEnv,
) {
  return resolveClickClackAccount({ cfg: accountConfig(settings), accountId, env });
}

function expectUnavailable(
  account: ResolvedClickClackAccount,
  configPath: string,
  reason: string,
  hiddenPath: string,
) {
  expect(account).toMatchObject({
    token: "",
    tokenSource: "tokenFile",
    tokenStatus: "configured_unavailable",
    credentialDiagnostics: [{ code: "CREDENTIAL_FILE_UNAVAILABLE", path: configPath, reason }],
  });
  expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(hiddenPath);
}

describe("ClickClack account resolution", () => {
  it("merges partial named-account group overrides with the root group policy", () => {
    const account = resolve(
      {
        token: "test-token-placeholder",
        groups: {
          " chn_1 ": {
            requireMention: true,
            requireMentionInBotThreads: false,
            mentionPatterns: ["@root-bot"],
          },
        },
        accounts: { work: { groups: { chn_1: { requireMention: false } } } },
      },
      "work",
    );
    expect(account.groups).toEqual({
      chn_1: {
        requireMention: false,
        requireMentionInBotThreads: false,
        mentionPatterns: ["@root-bot"],
      },
    });
    expect(account.config.groups).toEqual(account.groups);
  });

  it("uses the default ClickClack env token only for the default account", () => {
    const cfg = accountConfig({ enabled: true, accounts: { work: {} } });
    const env = { CLICKCLACK_BOT_TOKEN: "  default-env-token  " };
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", env.CLICKCLACK_BOT_TOKEN);

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveClickClackAccount({ cfg, env }).token).toBe("default-env-token");
    expect(resolveClickClackAccount({ cfg, accountId: "work", env }).token).toBe("");
  });

  it("reads tokenFile credentials without overriding a named account token", async () => {
    await withTempDir("clickclack-token-", async (tempDir) => {
      const tokenFile = path.join(tempDir, "token");
      fs.writeFileSync(tokenFile, "  file-token  \n", "utf8");
      const settings = {
        enabled: true,
        tokenFile,
        accounts: { work: { token: "work-token" } },
      };
      expect(listClickClackAccountIds(accountConfig(settings))).toEqual(["default", "work"]);
      expect(resolve(settings).token).toBe("file-token");
      expect(resolve(settings, "work").token).toBe("work-token");
    });
  });

  it("isolates unavailable root and account token files without falling back", async () => {
    await withTempDir("clickclack-unavailable-token-", async (tempDir) => {
      const missingRootFile = path.join(tempDir, "missing-root-token");
      const missingAccountFile = path.join(tempDir, "missing-account-token");
      const missingDefaultFile = path.join(tempDir, "missing-default-token");
      const cfg = accountConfig({
        token: "lower-priority-config-token",
        tokenFile: missingRootFile,
        accounts: {
          default: { tokenFile: missingDefaultFile },
          inherited: {},
          work: { tokenFile: missingAccountFile },
        },
      });
      const env = { CLICKCLACK_BOT_TOKEN: "lower-priority-env-token" };

      for (const [accountId, filePath, configPath] of [
        ["default", missingDefaultFile, "channels.clickclack.accounts.default.tokenFile"],
        ["inherited", missingRootFile, "channels.clickclack.tokenFile"],
        ["work", missingAccountFile, "channels.clickclack.accounts.work.tokenFile"],
      ] as const) {
        const account = resolveClickClackAccount({ cfg, accountId, env });
        expect(account.configured).toBe(true);
        expectUnavailable(account, configPath, "not-found", filePath);
      }
    });
  });

  it("degrades empty and unsafe token files without exposing their filesystem paths", async () => {
    await withTempDir("clickclack-invalid-token-", async (tempDir) => {
      const emptyFile = path.join(tempDir, "empty-token");
      fs.writeFileSync(emptyFile, "  \n", "utf8");
      const invalidFiles: Array<[string, "invalid-path" | "symlink"]> = [
        [emptyFile, "invalid-path"],
      ];
      if (process.platform !== "win32") {
        const tokenFile = path.join(tempDir, "valid-token");
        const symlink = path.join(tempDir, "token-link");
        fs.writeFileSync(tokenFile, "file-token", "utf8");
        fs.symlinkSync(tokenFile, symlink);
        invalidFiles.push([symlink, "symlink"]);
      }

      for (const [selectedFile, reason] of invalidFiles) {
        const account = resolve({ token: "lower-priority-token", tokenFile: selectedFile });
        expectUnavailable(account, "channels.clickclack.tokenFile", reason, selectedFile);
      }
    });
  });

  it("resolves model-mode bot account policy", () => {
    const policy = {
      token: "token-oversized",
      agentId: "peter-bot",
      replyMode: "model",
      model: "openai/gpt-5.4-mini",
      toolsAllow: ["web_search"],
    } satisfies ClickClackAccountConfig;
    expect(resolve({ enabled: true, accounts: { peter: policy } }, "peter")).toEqual({
      ...policy,
      ...ACCOUNT_BASE,
      allowBots: false,
      allowFrom: ["*"],
      accountId: "peter",
      apiEndpoint: "https://app.clickclack.chat",
      config: {
        ...policy,
        ...ACCOUNT_BASE,
        allowFrom: ["*"],
        enabled: true,
      },
      configured: true,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      commandMenu: true,
      discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
      groups: {},
      mentionPatterns: [],
      nativeProgress: false,
      reconnectMs: 1_500,
      requireMention: false,
      tokenSource: "config",
      tokenStatus: "available",
    });
  });

  it("normalizes per-account discussion settings and defaults", () => {
    const cfg = accountConfig({
      enabled: true,
      token: "test-token",
      workspace: "default",
      discussions: {
        enabled: true,
        controlUrlBase: "https://team.openclaw.ai/",
      },
      accounts: {
        support: {
          workspace: "support",
          discussions: { enabled: true, workspace: "operations", section: "Live work" },
        },
      },
    });

    expect(resolveClickClackAccount({ cfg }).discussions).toEqual({
      enabled: true,
      workspace: "default",
      controlUrlBase: "https://team.openclaw.ai/",
      section: "Sessions",
    });
    expect(resolveClickClackAccount({ cfg, accountId: "support" }).discussions).toEqual({
      enabled: true,
      workspace: "operations",
      controlUrlBase: "https://team.openclaw.ai/",
      section: "Live work",
    });
  });
});

const selectedEnvId = "CLICKCLACK_SELECTED_TEST_TOKEN";
const selectedRef = { source: "env", provider: "selected", id: selectedEnvId } as const;
const otherRef = { ...selectedRef, provider: "other" };
const fallbackEnv = { CLICKCLACK_BOT_TOKEN: "fallback-token" };
type SecretProviders = NonNullable<CoreConfig["secrets"]>["providers"];
function resolveRef(
  token: ClickClackAccountConfig["token"],
  providers?: SecretProviders,
  value?: string,
  named = false,
) {
  return resolveClickClackAccount({
    cfg: accountConfig(
      named ? { token: "lower-priority-root-token", accounts: { work: { token } } } : { token },
      { defaults: { env: "selected" }, providers },
    ),
    accountId: named ? "work" : undefined,
    env: { ...fallbackEnv, [selectedEnvId]: value },
  });
}

describe("ClickClack SecretRef provider policy", () => {
  it.each([
    ["exec", " injected-token ", "injected-token"],
    ["file", undefined, ""],
  ] as const)(
    "uses injected env, not ambient or fallback, with a selected %s alias",
    (source, value, token) => {
      vi.stubEnv(selectedEnvId, "ambient-token-must-not-win");
      const providers =
        source === "exec"
          ? { selected: { source, command: "/unused" } }
          : { selected: { source, path: "/unused" } };
      expect(resolveRef(selectedRef, providers, value, true)).toMatchObject({
        accountId: "work",
        token,
        tokenSource: "config",
        tokenStatus: token ? "available" : "configured_unavailable",
        configured: true,
      });
    },
  );

  it.each<[ClickClackAccountConfig["token"], SecretProviders, string]>([
    [
      selectedRef,
      { selected: { source: "env", allowlist: [] } },
      `Environment variable "${selectedEnvId}" is not allowlisted in secrets.providers.selected.allowlist.`,
    ],
    [
      otherRef,
      { other: { source: "file", path: "/unused" } },
      'Secret provider "other" has source "file" but ref requests "env".',
    ],
    [
      otherRef,
      undefined,
      `Secret provider "other" is not configured (ref: env:other:${selectedEnvId}).`,
    ],
  ])("rejects an unauthorized env provider (%#)", (token, providers, message) => {
    expect(() => resolveRef(token, providers, "injected-token")).toThrow(new Error(message));
  });

  it("never borrows an env token for a file source ref", () => {
    expect(
      resolveRef(
        { source: "file", provider: "default", id: "/selected/token" },
        undefined,
        "wrong-source-token",
      ),
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
    const token = { source: "env", provider: "default", id: selectedEnvId } as const;
    const cfg = accountConfig(
      {
        token,
        accounts: {
          work: { token },
          disabled: { token, enabled: false },
          unavailable: { token: { ...token, id: "CLICKCLACK_MISSING_TEST_TOKEN" } },
        },
      },
      { providers: { default: { source: "file", path: "/unused" } } },
    );
    expect(listEnabledClickClackAccounts(cfg)).toMatchObject([
      { accountId: "default", tokenStatus: "available", token: "selected-token" },
      { accountId: "unavailable", tokenStatus: "configured_unavailable", token: "" },
      { accountId: "work", tokenStatus: "available", token: "selected-token" },
    ]);
  });
});
