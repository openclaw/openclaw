// Nextcloud Talk tests cover setup plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupContract,
  normalizeNextcloudTalkBaseUrl,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

function talkConfig(config: NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk"]>) {
  return { channels: { "nextcloud-talk": config } };
}

describe("nextcloud talk setup", () => {
  it("shows a bot install command with webhook, response, and reaction features", () => {
    expect(nextcloudTalkSetupWizard.introNote?.lines.join("\n")).toContain(
      "--feature webhook --feature response --feature reaction",
    );
  });

  it("normalizes and validates base urls", () => {
    expect(normalizeNextcloudTalkBaseUrl(" https://cloud.example.com/// ")).toBe(
      "https://cloud.example.com",
    );
    expect(normalizeNextcloudTalkBaseUrl(undefined)).toBe("");

    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(
      "URL must start with http:// or https://",
    );
    expect(validateNextcloudTalkBaseUrl("https://cloud.example.com")).toBeUndefined();
  });

  it("sets top-level DM policy state", () => {
    const base: CoreConfig = talkConfig({});

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toEqual(
      talkConfig({
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    );
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const base: CoreConfig = talkConfig({
      defaultAccount: "work",
      dmPolicy: "disabled",
      accounts: {
        work: {
          baseUrl: "https://cloud.example.com",
          botSecret: "work-secret",
          dmPolicy: "allowlist",
        },
      },
    });

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("allowlist");
    expect(nextcloudTalkDmPolicy.resolveConfigKeys?.(base)).toEqual({
      policyKey: "channels.nextcloud-talk.accounts.work.dmPolicy",
      allowFromKey: "channels.nextcloud-talk.accounts.work.allowFrom",
    });

    const next = nextcloudTalkDmPolicy.setPolicy(base, "open");
    expect(next.channels?.["nextcloud-talk"]?.dmPolicy).toBe("disabled");
    const workAccount = next.channels?.["nextcloud-talk"]?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it('writes open DM policy to the named account and preserves inherited allowFrom with "*"', () => {
    const next = nextcloudTalkDmPolicy.setPolicy(
      talkConfig({
        allowFrom: ["alice"],
        accounts: {
          work: {
            baseUrl: "https://cloud.example.com",
            botSecret: "work-secret",
          },
        },
      }),
      "open",
      "work",
    );

    expect(next.channels?.["nextcloud-talk"]?.dmPolicy).toBeUndefined();
    const workAccount = next.channels?.["nextcloud-talk"]?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["alice", "*"]);
  });

  it("validates env/default-account constraints and applies config patches", () => {
    const validateInput = expectDefined(
      nextcloudTalkSetupContract.validateInput,
      "setup validator",
    );
    const applyAccountConfig = nextcloudTalkSetupContract.applyAccountConfig;
    const validate = (
      input: Parameters<typeof validateInput>[0]["input"],
      accountId = DEFAULT_ACCOUNT_ID,
    ) => validateInput({ cfg: {}, accountId, input });

    expect(validate({ useEnv: true }, "work")).toBe(
      "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.",
    );
    expect(validate({ useEnv: false, baseUrl: "", secret: "" })).toBe(
      "Nextcloud Talk requires bot secret or --secret-file (or --use-env).",
    );
    expect(validate({ useEnv: false, secret: "secret", baseUrl: "" })).toBe(
      "Nextcloud Talk requires --base-url.",
    );
    expect(validate({ secret: "secret", baseUrl: "ftp://cloud.example.com" })).toBe(
      "URL must start with http:// or https://",
    );
    expect(validate({ secret: "secret", baseUrl: "cloud.example.com" })).toBe(
      "URL must start with http:// or https://",
    );
    expect(
      validate({ secret: "secret", baseUrl: " https://cloud.example.com/talk/// " }),
    ).toBeNull();
    expect(validate({ secret: "secret", baseUrl: "http://cloud.example.com" })).toBeNull();

    expect(
      applyAccountConfig({
        cfg: talkConfig({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          baseUrl: " https://cloud.example.com/// ",
          secret: "bot-secret",
        },
      } as never),
    ).toEqual(
      talkConfig({
        enabled: true,
        name: "Default",
        baseUrl: "https://cloud.example.com",
        botSecret: "bot-secret",
      }),
    );

    expect(
      applyAccountConfig({
        cfg: talkConfig({
          accounts: {
            work: {
              botSecret: "old-secret",
            },
          },
        }),
        accountId: "work",
        input: {
          name: "Work",
          useEnv: true,
          baseUrl: "https://cloud.example.com",
        },
      } as never),
    ).toEqual(
      talkConfig({
        enabled: true,
        accounts: {
          work: {
            enabled: true,
            name: "Work",
            baseUrl: "https://cloud.example.com",
          },
        },
      }),
    );
  });

  it("normalizes legacy CLI aliases before applying account config", async () => {
    const prepareInput = expectDefined(
      nextcloudTalkSetupContract.prepareAccountConfigInput,
      "setup input normalizer",
    );

    const prepared = await prepareInput({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        url: "https://cloud.example.com",
        token: "bot-secret",
        tokenFile: "/tmp/bot-secret",
      },
      runtime: {} as never,
    });
    expect(prepared).toEqual({
      url: "https://cloud.example.com",
      token: "bot-secret",
      tokenFile: "/tmp/bot-secret",
      baseUrl: "https://cloud.example.com",
      secret: "bot-secret",
      secretFile: "/tmp/bot-secret",
    });

    const passwordPrepared = await prepareInput({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: { password: "legacy-secret" },
      runtime: {} as never,
    });
    expect(passwordPrepared).toMatchObject({ secret: "legacy-secret" });
  });

  it("clears stored bot secret fields when switching the default account to env", () => {
    const next = nextcloudTalkSetupContract.applyAccountConfig({
      cfg: talkConfig({
        enabled: true,
        baseUrl: "https://cloud.old.example",
        botSecret: "stored-secret",
        botSecretFile: "/tmp/secret.txt",
      }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        baseUrl: "https://cloud.example.com",
        useEnv: true,
      },
    });

    expect(next.channels?.["nextcloud-talk"]?.baseUrl).toBe("https://cloud.example.com");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("clears stored bot secret fields when the wizard switches to env", async () => {
    const credential = expectDefined(
      nextcloudTalkSetupWizard.credentials[0],
      "Nextcloud Talk credential",
    );
    const next = await credential.applyUseEnv?.({
      cfg: talkConfig({
        enabled: true,
        baseUrl: "https://cloud.example.com",
        botSecret: "stored-secret",
        botSecretFile: "/tmp/secret.txt",
      }),
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("replaces only the selected account's API password when the wizard sets a credential", async () => {
    const credential = expectDefined(
      nextcloudTalkSetupWizard.credentials[1],
      "Nextcloud Talk API credential",
    );
    const next = await credential.applySet?.({
      cfg: talkConfig({
        botSecret: "root-secret",
        accounts: {
          work: {
            baseUrl: "https://cloud.example.com",
            botSecret: "work-secret",
            apiUser: "bot",
            apiPassword: "old-password",
            apiPasswordFile: "/run/secrets/old-api-password",
          },
        },
      }),
      accountId: "work",
      credentialValues: {},
      value: "new-password",
      resolvedValue: "new-password",
    });

    expect(next?.channels?.["nextcloud-talk"]?.botSecret).toBe("root-secret");
    expect(next?.channels?.["nextcloud-talk"]?.accounts?.work).toEqual({
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "work-secret",
      apiUser: "bot",
      apiPassword: "new-password",
    });
  });
});

describe("resolveNextcloudTalkAccount", () => {
  it("ignores a blank bot secret file before credential precedence", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: talkConfig({
        baseUrl: "https://cloud.example.com",
        botSecret: "inline-secret",
        botSecretFile: "   ",
      }),
    });

    expect(account.secret).toBe("inline-secret");
    expect(account.secretSource).toBe("config");
    expect(account.tokenStatus).toBe("available");
    expect(account.credentialDiagnostics).toBeUndefined();
  });

  it("matches normalized configured account ids", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: talkConfig({
        accounts: {
          "Ops Team": {
            baseUrl: "https://cloud.example.com",
            botSecret: "bot-secret",
          },
        },
      }),
      accountId: "ops-team",
    });

    expect(account.accountId).toBe("ops-team");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("bot-secret");
    expect(account.secretSource).toBe("config");
  });

  it.runIf(process.platform !== "win32")(
    "marks symlinked botSecretFile paths configured-unavailable",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-"));
      const secretFile = path.join(dir, "secret.txt");
      const secretLink = path.join(dir, "secret-link.txt");
      fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
      fs.symlinkSync(secretFile, secretLink);

      const cfg = talkConfig({
        baseUrl: "https://cloud.example.com",
        botSecretFile: secretLink,
      });

      const account = resolveNextcloudTalkAccount({ cfg });
      expect(account.secret).toBe("");
      expect(account.secretSource).toBe("secretFile");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.credentialDiagnostics).toEqual([
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.nextcloud-talk.accounts.default.botSecretFile",
          reason: "symlink",
        },
      ]);
      expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(secretLink);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it("does not fall through from a missing explicit bot secret file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-missing-"));
    const secretFile = path.join(dir, "missing-secret.txt");
    const account = resolveNextcloudTalkAccount({
      cfg: talkConfig({
        baseUrl: "https://cloud.example.com",
        botSecret: "inline-fallback",
        botSecretFile: secretFile,
      }),
    });

    expect(account.secret).toBe("");
    expect(account.secretSource).toBe("secretFile");
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(secretFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: talkConfig({
        defaultAccount: "work",
        botSecret: "top-secret",
        accounts: {
          work: {
            baseUrl: "https://cloud.example.com",
            botSecret: "work-secret",
          },
        },
      }),
    });

    expect(account.accountId).toBe("work");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("work-secret");
    expect(account.secretSource).toBe("config");
  });

  it("uses configured defaultAccount for omitted setup configured state", () => {
    const configured = nextcloudTalkSetupWizard.status.resolveConfigured({
      cfg: talkConfig({
        defaultAccount: "work",
        baseUrl: "https://root.example.com",
        botSecret: "root-secret",
        accounts: {
          alerts: {
            baseUrl: "https://alerts.example.com",
            botSecret: "alerts-secret",
          },
          work: {
            baseUrl: "",
            botSecret: "",
          },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});
