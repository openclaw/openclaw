import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramSetupPlugin } from "../setup-plugin-api.js";
import { inspectTelegramAccount } from "./account-inspect.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";
import { resolveTelegramToken } from "./token.js";

const config = telegramSetupPlugin.config;
let workspace: TempWorkspaceSync | undefined;
function createTokenFile(fileName: string, contents: string): string {
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
function telegramConfig(
  telegram: NonNullable<OpenClawConfig["channels"]>["telegram"],
  secrets?: OpenClawConfig["secrets"],
): OpenClawConfig {
  return { channels: { telegram }, ...(secrets ? { secrets } : {}) };
}

it.each([
  { accountId: "work", configured: false },
  { accountId: "ops", configured: true },
])("preserves credential owner status for $accountId", ({ accountId, configured }) =>
  withEnv({ TELEGRAM_BOT_TOKEN: undefined, TG_INSPECTION_MISSING: undefined }, () => {
    const cfg = telegramConfig({
      defaultAccount: "alerts",
      webhookUrl: "https://example.test/telegram",
      groups: { "*": { requireMention: false } },
      accounts: {
        alerts: { botToken: "123:shared" },
        work: { botToken: "123:shared" },
        ops: { botToken: "456:healthy" },
        missing: {},
        unavailable: { botToken: "${TG_INSPECTION_MISSING}" },
      },
    });
    const inspected = inspectTelegramAccount({ cfg, accountId });
    expect(inspected).toMatchObject({
      accountId,
      enabled: true,
      configured,
      tokenStatus: "available",
      mode: "webhook",
      allowUnmentionedGroups: true,
    });
    expect(config.describeAccount?.(inspected, cfg)?.configured).toBe(configured);
    expect(config.isConfigured?.(inspected, cfg)).toBe(configured);
    if (accountId === "work") {
      expect(config.unconfiguredReason?.(inspected, cfg)).toContain('account "alerts"');
    }
  }),
);

it("keeps read-only accessors from resolving bot token SecretRefs", () => {
  const cfg = telegramConfig(
    {
      botToken: { source: "file", provider: "telegram_token", id: "value" },
      allowFrom: ["1128540374256849009"],
      defaultTo: "1498959610751750304",
    },
    {
      providers: {
        telegram_token: {
          source: "file",
          path: "/tmp/openclaw-missing-telegram-token",
          mode: "singleValue",
        },
      },
    },
  );
  expect(config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["1128540374256849009"]);
  expect(config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe("1498959610751750304");
});

it.each([
  { name: "TG_STATUS_TOKEN", secrets: undefined, tokenStatus: "available", token: "123:token" },
  {
    name: "TG_NOT_ALLOWED",
    secrets: {
      defaults: { env: "secure-env" },
      providers: { "secure-env": { source: "env" as const, allowlist: ["TG_ALLOWED"] } },
    },
    tokenStatus: "configured_unavailable",
    token: "",
  },
])(
  "resolves env templates subject to the provider allowlist: $name",
  ({ name, secrets, tokenStatus, token }) =>
    withEnv({ [name]: "123:token" }, () => {
      const cfg = telegramConfig({ botToken: `\${${name}}` }, secrets);
      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account).toMatchObject({ tokenSource: "env", tokenStatus, token });
    }),
);

it("routes omitted-account inspection through the configured defaultAccount (#61012)", () =>
  withEnv({ TELEGRAM_BOT_TOKEN: "123:env" }, () => {
    const cfg = telegramConfig({
      botToken: "123:channel",
      defaultAccount: "ops",
      accounts: { ops: { botToken: "123:ops" } },
    });
    expect(inspectTelegramAccount({ cfg })).toMatchObject({
      accountId: "ops",
      tokenSource: "config",
      token: "123:ops",
    });
  }));

it("reads groups from a mixed-case account key for unmentioned group status", () => {
  const cfg = telegramConfig({
    groups: { "-100999": { requireMention: true } },
    accounts: { Work: { botToken: "123:work", groups: { "-100123": { requireMention: false } } } },
  });
  expect(inspectTelegramAccount({ cfg, accountId: "work" }).allowUnmentionedGroups).toBe(true);
});

it("blocks channel-token fallback for unknown scoped accounts in multi-account config", () => {
  const cfg = telegramConfig({
    botToken: "123:channel",
    accounts: { work: { botToken: "123:work" } },
  });
  expect(inspectTelegramAccount({ cfg, accountId: "unknown" })).toMatchObject({
    accountId: "unknown",
    configured: false,
    tokenSource: "none",
    tokenStatus: "missing",
  });
});

it.runIf(process.platform !== "win32")(
  "treats symlinked token files as configured_unavailable",
  () => {
    const tokenFile = createTokenFile("token.txt", "123:token\n");
    const tokenLink = path.join(path.dirname(tokenFile), "token-link.txt");
    fs.symlinkSync(tokenFile, tokenLink);

    const cfg = telegramConfig({ tokenFile: tokenLink, botToken: "fallback-token" });
    const diagnostics = [
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.telegram.tokenFile",
        reason: "symlink",
      },
    ];
    const account = inspectTelegramAccount({ cfg, accountId: "default" });
    expect(account).toMatchObject({
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
      token: "",
    });
    expect(account.credentialDiagnostics).toEqual(diagnostics);
    const resolved = resolveTelegramToken(cfg);
    expect(resolved).toEqual({
      token: "",
      source: "tokenFile",
      credentialDiagnostics: diagnostics,
    });
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(tokenLink);
    expect(JSON.stringify(resolved)).not.toContain(tokenLink);
  },
);

it.each(["not-a-bot:secret", "9007199254740992:secret"])(
  "rejects invalid bot identity %j",
  (token) => expect(resolveTelegramBotUserIdFromToken(token)).toBeUndefined(),
);

describe("resolveTelegramToken", () => {
  const envRef = (provider = "telegram-env", id = "TELEGRAM_BOT_TOKEN") => ({
    source: "env" as const,
    provider,
    id,
  });
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
      expect(
        resolveTelegramToken(telegramConfig({ ...root, accounts: { default: selected } })),
      ).toEqual({
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
    expect(resolveTelegramToken(telegramConfig(telegram), { accountId })).toEqual({
      token: "",
      source: "none",
    });
  });

  it("resolves an explicitly allowlisted env provider", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "secretref-env-token");
    const cfg = telegramConfig(
      { botToken: envRef() },
      {
        defaults: { env: "telegram-env" },
        providers: { "telegram-env": { source: "env", allowlist: ["TELEGRAM_BOT_TOKEN"] } },
      },
    );
    expect(resolveTelegramToken(cfg)).toEqual({ token: "secretref-env-token", source: "config" });
  });

  it.each([
    [
      envRef(),
      { providers: { "telegram-env": { source: "env", allowlist: [] } } },
      /not allowlisted in secrets\.providers\.telegram-env\.allowlist/i,
    ],
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
    expect(() => resolveTelegramToken(telegramConfig({ botToken }, secrets))).toThrow(error);
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  it("falls through to channel-level token for binding-created accountId without accounts section", () => {
    expect(
      resolveTelegramToken(telegramConfig({ botToken: "channel-level-token", enabled: true }), {
        accountId: "bot-main",
      }),
    ).toEqual({ token: "channel-level-token", source: "config" });
  });
});
