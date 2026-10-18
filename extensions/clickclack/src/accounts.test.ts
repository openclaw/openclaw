import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listClickClackAccountIds, resolveClickClackAccount } from "./accounts.js";
import type { ClickClackAccountConfig, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const ACCOUNT_BASE = { baseUrl: "https://app.clickclack.chat", workspace: "wsp_1" };
function accountConfig(
  settings: ClickClackAccountConfig & { accounts?: Record<string, ClickClackAccountConfig> },
): CoreConfig {
  return { channels: { clickclack: { ...ACCOUNT_BASE, ...settings } } };
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
  afterEach(() => vi.unstubAllEnvs());

  it("merges partial named-account group overrides with the root group policy", () => {
    const cfg = accountConfig({
      token: "test-token-placeholder",
      groups: {
        " chn_1 ": {
          requireMention: true,
          requireMentionInBotThreads: false,
          mentionPatterns: ["@root-bot"],
        },
      },
      accounts: { work: { groups: { chn_1: { requireMention: false } } } },
    });

    const account = resolveClickClackAccount({ cfg, accountId: "work" });
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
      const cfg = accountConfig({
        enabled: true,
        tokenFile,
        accounts: { work: { token: "work-token" } },
      });

      expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
      expect(resolveClickClackAccount({ cfg }).token).toBe("file-token");
      expect(resolveClickClackAccount({ cfg, accountId: "work" }).token).toBe("work-token");
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
        const account = resolveClickClackAccount({
          cfg: accountConfig({ token: "lower-priority-token", tokenFile: selectedFile }),
        });

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
    const cfg = accountConfig({ enabled: true, accounts: { peter: policy } });

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toEqual({
      ...policy,
      allowBots: false,
      allowFrom: ["*"],
      accountId: "peter",
      apiEndpoint: "https://app.clickclack.chat",
      baseUrl: "https://app.clickclack.chat",
      botLoopProtection: undefined,
      config: {
        ...policy,
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        tokenFile: undefined,
        workspace: "wsp_1",
      },
      configured: true,
      botUserId: undefined,
      defaultTo: "channel:general",
      enabled: true,
      agentActivity: false,
      commandMenu: true,
      discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
      groups: {},
      mentionPatterns: [],
      name: undefined,
      nativeProgress: false,
      reconnectMs: 1_500,
      requireMention: false,
      systemPrompt: undefined,
      tokenSource: "config",
      tokenStatus: "available",
      workspace: "wsp_1",
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
