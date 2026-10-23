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

function config(
  telegram: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
  secrets?: OpenClawConfig["secrets"],
): OpenClawConfig {
  return { channels: { telegram }, ...(secrets ? { secrets } : {}) };
}

function envRef(provider = "telegram-env", id = "TELEGRAM_BOT_TOKEN") {
  return { source: "env" as const, provider, id };
}

describe("resolveTelegramBotUserIdFromToken", () => {
  it.each([
    ["not-a-bot:secret", undefined],
    ["9007199254740992:secret", undefined],
  ])("parses %j as %j", (token, expected) => {
    expect(resolveTelegramBotUserIdFromToken(token)).toBe(expected);
  });
});

describe("resolveTelegramToken", () => {
  let workspace: TempWorkspaceSync | undefined;
  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    workspace ??= tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-telegram-token-",
    });
    const tokenFile = path.join(workspace.dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf-8");
    return tokenFile;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    workspace?.cleanup();
    workspace = undefined;
  });

  it.runIf(process.platform !== "win32")(
    "marks symlinked tokenFile paths configured-unavailable",
    () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
      const tokenFile = createTokenFile("token.txt");
      const tokenLink = path.join(path.dirname(tokenFile), "token-link.txt");
      fs.symlinkSync(tokenFile, tokenLink);

      const result = resolveTelegramToken(
        config({ tokenFile: tokenLink, botToken: "fallback-token" }),
      );
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
    const channel = { botToken: "channel-config-token", tokenFile: channelTokenFile };
    const account = { botToken: "account-config-token", tokenFile: accountTokenFile };
    for (const [root, selected, token, source] of [
      [channel, account, "account-file-token", "tokenFile"],
      [channel, { botToken: account.botToken }, "account-config-token", "config"],
      [channel, {}, "channel-file-token", "tokenFile"],
      [{ botToken: channel.botToken }, {}, "channel-config-token", "config"],
      [{}, {}, "env-token", "env"],
    ] as const) {
      expect(resolveTelegramToken(config({ ...root, accounts: { default: selected } }))).toEqual({
        token,
        source,
      });
    }
  });

  it.each([
    ["non-default env", { accounts: { work: {} } }, "work", "env-token"],
    [
      "unknown account",
      { botToken: "wrong-bot-token", accounts: { knownBot: { botToken: "known-bot-token" } } },
      "unknownBot",
      "",
    ],
    [
      "unavailable ref",
      { botToken: envRef("default", "TELEGRAM_REF_TOKEN") },
      undefined,
      "fallback-env-token",
    ],
  ] as const)("does not fall back for %s", (_name, telegram, accountId, envToken) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", envToken);
    vi.stubEnv("TELEGRAM_REF_TOKEN", "");
    expect(resolveTelegramToken(config(telegram), { accountId })).toEqual({
      token: "",
      source: "none",
    });
  });

  it.each([[], ["TELEGRAM_BOT_TOKEN"]].map((allowlist) => ({ allowlist })))(
    "honors the selected explicit env provider allowlist $allowlist",
    ({ allowlist }) => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
      const cfg = config(
        { botToken: envRef() },
        {
          defaults: { env: "telegram-env" },
          providers: { "telegram-env": { source: "env", allowlist } },
        },
      );

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

  it.each([
    [
      envRef(),
      { providers: { "telegram-env": { source: "file", path: "/tmp/secrets.json" } } },
      /Secret provider "telegram-env" has source "file" but ref requests "env"/i,
    ],
    [
      envRef("ops-env"),
      undefined,
      /Secret provider "ops-env" is not configured \(ref: env:ops-env:TELEGRAM_BOT_TOKEN\)/i,
    ],
    [
      { source: "file", provider: "vault", id: "/telegram/bot-token" },
      undefined,
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    ],
  ] as const)("rejects unavailable SecretRef %j", (botToken, secrets, error) => {
    expect(() => resolveTelegramToken(config({ botToken }, secrets))).toThrow(error);
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    expect(
      resolveTelegramToken(config({ botToken: "channel-level-token", enabled: true }), {
        accountId: "bot-main",
      }),
    ).toEqual({ token: "channel-level-token", source: "config" });
  });
});
