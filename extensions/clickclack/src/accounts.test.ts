// Clickclack tests cover accounts plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

function channelConfig(
  clickclack: NonNullable<NonNullable<CoreConfig["channels"]>["clickclack"]>,
): CoreConfig {
  return { channels: { clickclack } };
}

const accountDefaults = {
  allowBots: false,
  allowFrom: ["*"],
  apiEndpoint: "https://app.clickclack.chat",
  baseUrl: "https://app.clickclack.chat",
  botLoopProtection: undefined,
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
};

describe("ClickClack account resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = channelConfig({
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      token: "test-token-placeholder",
      accounts: {
        work: { enabled: false },
      },
    });

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("default");
    expect(resolveClickClackAccount({ cfg }).token).toBe("test-token-placeholder");
  });

  it("merges partial named-account group overrides with the root group policy", () => {
    const cfg = channelConfig({
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      token: "test-token-placeholder",
      groups: {
        " chn_1 ": {
          requireMention: true,
          mentionPatterns: ["@root-bot"],
        },
      },
      accounts: {
        work: {
          groups: {
            chn_1: {
              requireMention: false,
            },
          },
        },
      },
    });

    const account = resolveClickClackAccount({ cfg, accountId: "work" });
    expect(account.groups).toEqual({
      chn_1: {
        requireMention: false,
        mentionPatterns: ["@root-bot"],
      },
    });
    expect(account.config.groups).toEqual(account.groups);
  });

  it("does not synthesize a partial top-level default account from inherited credentials", () => {
    const cfg = channelConfig({
      token: "test-auth-token",
      accounts: {
        work: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
        },
      },
    });

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("does not synthesize a default account from blank top-level credentials", () => {
    const cfg = channelConfig({
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_default",
      token: "   ",
      accounts: {
        work: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "gateway-token",
        },
      },
    });

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("resolves env SecretRefs at runtime", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      accounts: {
        service: {
          token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
        },
      },
    });

    expect(
      resolveClickClackAccount({
        cfg,
        accountId: "service",
        env: { CLICKCLACK_SERVICE_TOKEN: "  test-token-placeholder  " },
      }),
    ).toEqual({
      ...accountDefaults,
      accountId: "service",
      config: {
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
        tokenFile: undefined,
        workspace: "wsp_1",
      },
      agentId: undefined,
      model: undefined,
      replyMode: "agent",
      token: "test-token-placeholder",
      toolsAllow: undefined,
    });
  });

  it("uses the default ClickClack env token only for the default account", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      accounts: {
        work: {},
      },
    });
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
      const cfg = channelConfig({
        enabled: true,
        baseUrl: "https://app.clickclack.chat",
        workspace: "wsp_1",
        tokenFile,
        accounts: {
          work: {
            token: "work-token",
          },
        },
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
      const cfg = channelConfig({
        baseUrl: "https://app.clickclack.chat",
        workspace: "wsp_1",
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
        expect(account).toMatchObject({
          configured: true,
          token: "",
          tokenSource: "tokenFile",
          tokenStatus: "configured_unavailable",
          credentialDiagnostics: [
            { code: "CREDENTIAL_FILE_UNAVAILABLE", path: configPath, reason: "not-found" },
          ],
        });
        expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(filePath);
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
          cfg: {
            channels: {
              clickclack: {
                baseUrl: "https://app.clickclack.chat",
                workspace: "wsp_1",
                token: "lower-priority-token",
                tokenFile: selectedFile,
              },
            },
          },
        });

        expect(account).toMatchObject({
          token: "",
          tokenSource: "tokenFile",
          tokenStatus: "configured_unavailable",
          credentialDiagnostics: [
            { code: "CREDENTIAL_FILE_UNAVAILABLE", path: "channels.clickclack.tokenFile", reason },
          ],
        });
        expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(selectedFile);
      }
    });
  });

  it("resolves model-mode bot account policy", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      accounts: {
        peter: {
          token: "token-oversized",
          agentId: "peter-bot",
          replyMode: "model",
          model: "openai/gpt-5.4-mini",
          toolsAllow: ["web_search"],
        },
      },
    });

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toEqual({
      ...accountDefaults,
      accountId: "peter",
      agentId: "peter-bot",
      config: {
        agentId: "peter-bot",
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        model: "openai/gpt-5.4-mini",
        replyMode: "model",
        token: "token-oversized",
        tokenFile: undefined,
        toolsAllow: ["web_search"],
        workspace: "wsp_1",
      },
      model: "openai/gpt-5.4-mini",
      replyMode: "model",
      token: "token-oversized",
      toolsAllow: ["web_search"],
    });
  });

  it("resolves the agent activity opt-in only when explicitly enabled", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      token: "test-token-placeholder",
      accounts: {
        bridge: {
          token: "clawrouter-e2e-secret",
          agentActivity: true,
        },
      },
    });

    expect(resolveClickClackAccount({ cfg }).agentActivity).toBe(false);
    expect(resolveClickClackAccount({ cfg, accountId: "bridge" }).agentActivity).toBe(true);
  });

  it("resolves a private API base per account and defaults it to the public base", () => {
    const cfg = channelConfig({
      baseUrl: "https://clack.openclaw.ai/",
      apiBaseUrl: "http://127.0.0.1:8484/",
      workspace: "default",
      token: "test-token-placeholder",
      accounts: {
        public: { apiBaseUrl: "https://api.clickclack.example/" },
        inherited: {},
      },
    });

    expect(resolveClickClackAccount({ cfg }).apiEndpoint).toBe("http://127.0.0.1:8484");
    expect(resolveClickClackAccount({ cfg, accountId: "public" }).apiEndpoint).toBe(
      "https://api.clickclack.example",
    );
    expect(resolveClickClackAccount({ cfg, accountId: "inherited" }).apiEndpoint).toBe(
      "http://127.0.0.1:8484",
    );

    const fallbackCfg = channelConfig({
      baseUrl: "https://clack.openclaw.ai/",
      workspace: "default",
      token: "test-token-placeholder",
    });
    expect(resolveClickClackAccount({ cfg: fallbackCfg }).apiEndpoint).toBe(
      "https://clack.openclaw.ai",
    );
  });

  it("normalizes per-account discussion settings and defaults", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
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

  it("enables command menus unless the resolved account explicitly disables them", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      workspace: "wsp_1",
      token: "test-token-placeholder",
      accounts: {
        disabled: {
          commandMenu: false,
        },
        enabled: {
          commandMenu: true,
        },
      },
    });

    expect(resolveClickClackAccount({ cfg }).commandMenu).toBe(true);
    expect(resolveClickClackAccount({ cfg, accountId: "disabled" }).commandMenu).toBe(false);
    expect(resolveClickClackAccount({ cfg, accountId: "enabled" }).commandMenu).toBe(true);
  });

  it("normalizes reconnect intervals to the public config bounds", () => {
    const cfg = channelConfig({
      enabled: true,
      baseUrl: "https://app.clickclack.chat",
      token: "very-long-browser-token-0123456789",
      workspace: "wsp_1",
      reconnectMs: 1,
      accounts: {
        slow: {
          reconnectMs: 1_000_000,
        },
      },
    });

    expect(resolveClickClackAccount({ cfg }).reconnectMs).toBe(100);
    expect(resolveClickClackAccount({ cfg, accountId: "slow" }).reconnectMs).toBe(60_000);
  });
});
