import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { inspectTelegramAccount } from "./account-inspect.js";
import { createTelegramPluginConfig } from "./config-adapter.js";

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
    const config = createTelegramPluginConfig();
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
  const config = createTelegramPluginConfig();
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

it("routes omitted-account inspection through the configured defaultAccount (#61012)", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "123:env" }, () => {
    const cfg = telegramConfig({
      botToken: "123:channel",
      defaultAccount: "ops",
      accounts: { ops: { botToken: "123:ops" } },
    });
    const account = inspectTelegramAccount({ cfg });
    expect(account).toMatchObject({ accountId: "ops", tokenSource: "config", token: "123:ops" });
  });
});

it("blocks channel-token fallback for unknown scoped accounts in multi-account config", () => {
  const cfg = telegramConfig({
    botToken: "123:channel",
    accounts: { work: { botToken: "123:work" } },
  });
  const account = inspectTelegramAccount({ cfg, accountId: "unknown" });
  expect(account).toMatchObject({
    accountId: "unknown",
    configured: false,
    tokenSource: "none",
    tokenStatus: "missing",
  });
});

it.runIf(process.platform !== "win32")(
  "treats symlinked token files as configured_unavailable",
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-inspect-"));
    const tokenFile = path.join(dir, "token.txt");
    const tokenLink = path.join(dir, "token-link.txt");
    fs.writeFileSync(tokenFile, "123:token\n", "utf8");
    fs.symlinkSync(tokenFile, tokenLink);

    const cfg = telegramConfig({ tokenFile: tokenLink });
    const account = inspectTelegramAccount({ cfg, accountId: "default" });
    expect(account).toMatchObject({
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
      token: "",
    });
    expect(account.credentialDiagnostics).toEqual([
      {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: "channels.telegram.tokenFile",
        reason: "symlink",
      },
    ]);
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(tokenLink);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);
