// Telegram tests cover account inspect plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { inspectTelegramAccount } from "./account-inspect.js";
import { createTelegramPluginConfig } from "./config-adapter.js";

describe("inspectTelegramAccount SecretRef resolution", () => {
  it.each([
    { accountId: "alerts", configured: true, startable: true, tokenStatus: "available" },
    { accountId: "work", configured: false, startable: false, tokenStatus: "available" },
    { accountId: "ops", configured: true, startable: true, tokenStatus: "available" },
    { accountId: "missing", configured: false, startable: false, tokenStatus: "missing" },
    {
      accountId: "unavailable",
      configured: true,
      startable: false,
      tokenStatus: "configured_unavailable",
    },
    { accountId: "unknown", configured: false, startable: false, tokenStatus: "missing" },
  ])(
    "preserves owner status for $accountId without resolving credentials",
    ({ accountId, configured, startable, tokenStatus }) => {
      withEnv({ TELEGRAM_BOT_TOKEN: undefined, TG_INSPECTION_MISSING: undefined }, () => {
        const cfg: OpenClawConfig = {
          channels: {
            telegram: {
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
            },
          },
        };
        const inspected = inspectTelegramAccount({ cfg, accountId });
        const config = createTelegramPluginConfig();
        expect(inspected).toMatchObject({
          accountId,
          enabled: true,
          configured,
          tokenStatus,
          mode: "webhook",
          allowUnmentionedGroups: true,
        });
        expect(config.describeAccount?.(inspected, cfg)?.configured).toBe(configured);
        expect(config.isConfigured?.(inspected, cfg)).toBe(startable);
        if (accountId === "work") {
          expect(config.unconfiguredReason?.(inspected, cfg)).toContain('account "alerts"');
        }
        if (accountId === "unknown") {
          expect(config.unconfiguredReason?.(inspected, cfg)).toContain("unknown accountId");
        }
      });
    },
  );

  it("keeps read-only accessors from resolving bot token SecretRefs", () => {
    const cfg: OpenClawConfig = {
      secrets: {
        providers: {
          telegram_token: {
            source: "file",
            path: "/tmp/openclaw-missing-telegram-token",
            mode: "singleValue",
          },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "file", provider: "telegram_token", id: "value" },
          allowFrom: ["1128540374256849009"],
          defaultTo: "1498959610751750304",
        },
      },
    };
    const config = createTelegramPluginConfig();
    expect(config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "1128540374256849009",
    ]);
    expect(config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe("1498959610751750304");
  });

  it("resolves default env SecretRef templates in read-only status paths", () => {
    withEnv({ TG_STATUS_TOKEN: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "${TG_STATUS_TOKEN}",
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("available");
      expect(account.token).toBe("123:token");
    });
  });

  it("respects env provider allowlists in read-only status paths", () => {
    withEnv({ TG_NOT_ALLOWED: "123:token" }, () => {
      const cfg: OpenClawConfig = {
        secrets: {
          defaults: {
            env: "secure-env",
          },
          providers: {
            "secure-env": {
              source: "env",
              allowlist: ["TG_ALLOWED"],
            },
          },
        },
        channels: {
          telegram: {
            botToken: "${TG_NOT_ALLOWED}",
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("env");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
    });
  });

  it("matches runtime token lookup for account keys that need full normalization", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            "Carey Notifications": {
              botToken: "123:token",
              reactionLevel: "ack",
            },
          },
        },
      },
    };

    const account = inspectTelegramAccount({
      cfg,
      accountId: "carey-notifications",
    });

    expect(account.accountId).toBe("carey-notifications");
    expect(account.configured).toBe(true);
    expect(account.tokenSource).toBe("config");
    expect(account.tokenStatus).toBe("available");
    expect(account.config.reactionLevel).toBe("ack");
  });

  it("routes omitted-account inspection through the configured defaultAccount (#61012)", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "123:env" }, () => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            botToken: "123:channel",
            defaultAccount: "ops",
            accounts: {
              ops: { botToken: "123:ops" },
            },
          },
        },
      };

      const account = inspectTelegramAccount({ cfg });
      expect(account.accountId).toBe("ops");
      expect(account.tokenSource).toBe("config");
      expect(account.token).toBe("123:ops");
    });
  });

  it("blocks channel-token fallback for unknown scoped accounts in multi-account config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "123:channel",
          accounts: {
            work: { botToken: "123:work" },
          },
        },
      },
    };

    const account = inspectTelegramAccount({ cfg, accountId: "unknown" });

    expect(account.accountId).toBe("unknown");
    expect(account.configured).toBe(false);
    expect(account.tokenSource).toBe("none");
    expect(account.tokenStatus).toBe("missing");
  });

  it.runIf(process.platform !== "win32")(
    "treats symlinked token files as configured_unavailable",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-inspect-"));
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      fs.writeFileSync(tokenFile, "123:token\n", "utf8");
      fs.symlinkSync(tokenFile, tokenLink);

      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            tokenFile: tokenLink,
          },
        },
      };

      const account = inspectTelegramAccount({ cfg, accountId: "default" });
      expect(account.tokenSource).toBe("tokenFile");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.token).toBe("");
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
});
