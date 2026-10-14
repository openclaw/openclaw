// Telegram tests cover token plugin behavior.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";
import { resolveTelegramToken } from "./token.js";

describe("resolveTelegramBotUserIdFromToken", () => {
  it.each([
    ["not-a-bot:secret", undefined],
    ["9007199254740992:secret", undefined],
  ])("parses %j as %j", (token, expected) => {
    expect(resolveTelegramBotUserIdFromToken(token)).toBe(expected);
  });
});

describe("resolveTelegramToken", () => {
  const tempWorkspaces: TempWorkspaceSync[] = [];
  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-telegram-token-",
    });
    tempWorkspaces.push(workspace);
    const tokenFile = path.join(workspace.dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf-8");
    return tokenFile;
  }

  function createUnknownAccountConfig(): OpenClawConfig {
    return {
      channels: {
        telegram: {
          botToken: "wrong-bot-token",
          accounts: {
            knownBot: { botToken: "known-bot-token" },
          },
        },
      },
    } as OpenClawConfig;
  }

  function expectNoTokenForUnknownAccount(cfg: OpenClawConfig) {
    const res = resolveTelegramToken(cfg, { accountId: "unknownBot" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
  });

  it("resolves the configured defaultAccount token when accountId is omitted (#61012)", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        telegram: {
          defaultAccount: "kitt",
          accounts: {
            kitt: { botToken: "kitt-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res).toEqual({ token: "kitt-token", source: "config" });
  });

  it.runIf(process.platform !== "win32")(
    "marks symlinked tokenFile paths configured-unavailable",
    () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-telegram-token-",
      });
      tempWorkspaces.push(workspace);
      const dir = workspace.dir;
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      fs.writeFileSync(tokenFile, "file-token\n", "utf-8");
      fs.symlinkSync(tokenFile, tokenLink);

      const cfg = {
        channels: { telegram: { tokenFile: tokenLink, botToken: "fallback-token" } },
      } as OpenClawConfig;
      const result = resolveTelegramToken(cfg);
      expect(result).toEqual({
        token: "",
        source: "tokenFile",
        credentialDiagnostics: [
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.telegram.tokenFile",
            reason: "symlink",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(tokenLink);
    },
  );

  it("applies account file, account config, channel file, channel config, then env precedence", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const accountTokenFile = createTokenFile("account-token.txt", "account-file-token\n");
    const channelTokenFile = createTokenFile("channel-token.txt", "channel-file-token\n");
    const baseTelegramConfig = {
      botToken: "channel-config-token",
      tokenFile: channelTokenFile,
      accounts: {
        default: {
          botToken: "account-config-token",
          tokenFile: accountTokenFile,
        },
      },
    };

    const resolve = (telegram: Record<string, unknown>) =>
      resolveTelegramToken({ channels: { telegram } } as OpenClawConfig);

    expect(resolve(baseTelegramConfig)).toEqual({
      token: "account-file-token",
      source: "tokenFile",
    });
    expect(
      resolve({
        ...baseTelegramConfig,
        accounts: { default: { botToken: "account-config-token" } },
      }),
    ).toEqual({ token: "account-config-token", source: "config" });
    expect(resolve({ ...baseTelegramConfig, accounts: { default: {} } })).toEqual({
      token: "channel-file-token",
      source: "tokenFile",
    });
    expect(
      resolve({
        ...baseTelegramConfig,
        tokenFile: undefined,
        accounts: { default: {} },
      }),
    ).toEqual({ token: "channel-config-token", source: "config" });
    expect(resolve({ accounts: { default: {} } })).toEqual({
      token: "env-token",
      source: "env",
    });
  });

  it("does not use env token for non-default accounts", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall through to channel-level token when non-default accountId is not in config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expectNoTokenForUnknownAccount(createUnknownAccountConfig());
  });

  it("does not fall back to TELEGRAM_BOT_TOKEN when a selected ref is unavailable", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fallback-env-token");
    vi.stubEnv("TELEGRAM_REF_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_REF_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramToken(cfg)).toEqual({
      token: "",
      source: "none",
    });
  });

  it.each([[], ["TELEGRAM_BOT_TOKEN"]].map((allowlist) => ({ allowlist })))(
    "honors the selected explicit env provider allowlist $allowlist",
    ({ allowlist }) => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
      const cfg = {
        secrets: {
          defaults: { env: "telegram-env" },
          providers: {
            "telegram-env": {
              source: "env",
              allowlist,
            },
          },
        },
        channels: {
          telegram: {
            botToken: { source: "env", provider: "telegram-env", id: "TELEGRAM_BOT_TOKEN" },
          },
        },
      } as unknown as OpenClawConfig;

      if (allowlist.includes("TELEGRAM_BOT_TOKEN")) {
        expect(resolveTelegramToken(cfg)).toEqual({
          token: "secretref-env-token",
          source: "config",
        });
      } else {
        expect(() => resolveTelegramToken(cfg)).toThrow(
          /not allowlisted in secrets\.providers\.telegram-env\.allowlist/i,
        );
      }
    },
  );

  it("throws when an env SecretRef points at a provider configured with another source", () => {
    const cfg = {
      secrets: {
        providers: {
          "telegram-env": {
            source: "file",
            path: "/tmp/secrets.json",
          },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "telegram-env", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /Secret provider "telegram-env" has source "file" but ref requests "env"/i,
    );
  });

  it("throws when an env SecretRef provider is not configured and not the default env alias", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "ops-env", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /Secret provider "ops-env" is not configured \(ref: env:ops-env:TELEGRAM_BOT_TOKEN\)/i,
    );
  });

  it("keeps strict runtime behavior for unresolved non-env SecretRefs", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "file", provider: "vault", id: "/telegram/bot-token" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    );
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  // Binding-created accountIds should inherit the channel-level token in
  // single-bot setups (no accounts section).
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-level-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "bot-main" });
    expect(res.token).toBe("channel-level-token");
    expect(res.source).toBe("config");
  });
});
