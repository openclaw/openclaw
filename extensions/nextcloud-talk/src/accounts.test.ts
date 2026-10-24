import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { nextcloudTalkPlugin } from "./channel.js";
import {
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupContract,
  normalizeNextcloudTalkBaseUrl,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

function talkConfig(config: NonNullable<CoreConfig["channels"]>["nextcloud-talk"]): CoreConfig {
  return { channels: { "nextcloud-talk": config } };
}
const accountConfig = (config: NonNullable<CoreConfig["channels"]>["nextcloud-talk"]) =>
  talkConfig({ baseUrl: "https://cloud.example.com", botSecret: "shared-secret", ...config });
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });

let directory: string;
let apiPasswordFile: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-config-"));
  apiPasswordFile = path.join(directory, "api-password");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Nextcloud Talk account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = accountConfig({ accounts: { work: { enabled: false } } });

    expect(listNextcloudTalkAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultNextcloudTalkAccountId(cfg)).toBe("default");
    expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
      accountId: "default",
      baseUrl: "https://cloud.example.com",
      secret: "shared-secret",
    });
  });

  it("inherits and overrides inbound media config through normal account resolution", () => {
    const media = { mediaAllowFrom: ["nextcloud-talk:alice"], mediaMaxMb: 20 };
    const restricted = { mediaAllowFrom: ["*"], mediaMaxMb: 5 };
    const cfg = accountConfig({
      ...media,
      accounts: { inherited: {}, restricted },
    });
    for (const accountId of ["default", "inherited"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId }).config).toMatchObject(media);
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "restricted" }).config).toMatchObject(
      restricted,
    );
  });

  it("isolates unavailable default and named account SecretRefs from ambient credentials", () => {
    vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "ambient-secret");
    const unavailableSecret = secretRef("MISSING_NEXTCLOUD_TALK_SECRET");
    const cfg = accountConfig({
      botSecret: unavailableSecret,
      accounts: {
        work: { botSecret: unavailableSecret },
        healthy: { botSecret: "healthy-secret" },
      },
    });

    for (const accountId of ["default", "work"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId })).toMatchObject({
        accountId,
        secret: "",
        secretSource: "config",
        tokenStatus: "configured_unavailable",
      });
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "healthy" })).toMatchObject({
      secret: "healthy-secret",
      tokenStatus: "available",
    });
  });

  it("preserves default env, file, then plaintext precedence without a SecretRef", () => {
    const secretFile = path.join(directory, "bot-secret");
    fs.writeFileSync(secretFile, "file-secret\n", "utf8");

    const config = {
      botSecret: "plaintext-secret",
      botSecretFile: secretFile,
    };
    for (const [env, file, secret, secretSource] of [
      ["ambient-secret", secretFile, "ambient-secret", "env"],
      ["", secretFile, "file-secret", "secretFile"],
      ["", undefined, "plaintext-secret", "config"],
    ] as const) {
      vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", env);
      const cfg = accountConfig({ ...config, botSecretFile: file });
      expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({ secret, secretSource });
    }
  });
});

const baseUrl = "https://cloud.example.com";
const invalidUrl = "URL must start with http:// or https://";
const { credentials, status } = nextcloudTalkSetupWizard;
const validateInput = expectDefined(nextcloudTalkSetupContract.validateInput, "setup validator");
const prepareInput = expectDefined(
  nextcloudTalkSetupContract.prepareAccountConfigInput,
  "setup input normalizer",
);
const prepare = (input: Parameters<typeof prepareInput>[0]["input"]) =>
  prepareInput({ cfg: {}, accountId: DEFAULT_ACCOUNT_ID, input, runtime: {} as never });
const apply = (
  input: Parameters<typeof nextcloudTalkSetupContract.applyAccountConfig>[0]["input"],
  cfg: CoreConfig = talkConfig({}),
  accountId = DEFAULT_ACCOUNT_ID,
) => nextcloudTalkSetupContract.applyAccountConfig({ cfg, accountId, input });
const validate = (
  input: Parameters<typeof validateInput>[0]["input"],
  accountId = DEFAULT_ACCOUNT_ID,
) => validateInput({ cfg: {}, accountId, input });

function assertUnavailableFile(botSecretFile: string, botSecret?: string) {
  const account = resolveNextcloudTalkAccount({
    cfg: talkConfig({ baseUrl, botSecretFile, botSecret }),
  });
  expect(account).toMatchObject({
    secret: "",
    secretSource: "secretFile",
    tokenStatus: "configured_unavailable",
  });
  expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(botSecretFile);
  return account;
}

describe("nextcloud talk setup", () => {
  it("normalizes and validates base urls", () => {
    expect(normalizeNextcloudTalkBaseUrl(` ${baseUrl}/// `)).toBe(baseUrl);
    expect(normalizeNextcloudTalkBaseUrl(undefined)).toBe("");

    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(invalidUrl);
    expect(validateNextcloudTalkBaseUrl(baseUrl)).toBeUndefined();
  });

  it("sets top-level DM policy state", () => {
    const base: CoreConfig = talkConfig({});
    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toEqual(
      talkConfig({ enabled: true, dmPolicy: "open", allowFrom: ["*"] }),
    );
  });

  it("validates env/default-account constraints and applies config patches", () => {
    expect(validate({ useEnv: true }, "work")).toBe(
      "NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.",
    );
    expect(validate({ useEnv: false, baseUrl: "", secret: "" })).toBe(
      "Nextcloud Talk requires bot secret or --secret-file (or --use-env).",
    );
    expect(validate({ useEnv: false, secret: "secret", baseUrl: "" })).toBe(
      "Nextcloud Talk requires --base-url.",
    );
    expect(validate({ secret: "secret", baseUrl: "ftp://cloud.example.com" })).toBe(invalidUrl);
    expect(validate({ secret: "secret", baseUrl: "cloud.example.com" })).toBe(invalidUrl);
    expect(
      validate({ secret: "secret", baseUrl: " https://cloud.example.com/talk/// " }),
    ).toBeNull();
    expect(validate({ secret: "secret", baseUrl: "http://cloud.example.com" })).toBeNull();

    expect(apply({ name: "Default", baseUrl: ` ${baseUrl}/// `, secret: "bot-secret" })).toEqual(
      talkConfig({ enabled: true, name: "Default", baseUrl, botSecret: "bot-secret" }),
    );

    expect(
      apply(
        { name: "Work", useEnv: true, baseUrl },
        talkConfig({ accounts: { work: { botSecret: "old-secret" } } }),
        "work",
      ),
    ).toEqual(
      talkConfig({
        enabled: true,
        accounts: { work: { enabled: true, name: "Work", baseUrl } },
      }),
    );
  });

  it("normalizes legacy CLI aliases before applying account config", async () => {
    const input = { url: baseUrl, token: "bot-secret", tokenFile: "/tmp/bot-secret" };
    expect(await prepare(input)).toEqual({
      ...input,
      baseUrl,
      secret: "bot-secret",
      secretFile: "/tmp/bot-secret",
    });

    expect(await prepare({ password: "legacy-secret" })).toMatchObject({ secret: "legacy-secret" });
  });

  it("clears stored bot secret fields when the wizard switches to env", async () => {
    const credential = expectDefined(credentials[0], "Nextcloud Talk credential");
    const next = await credential.applyUseEnv?.({
      cfg: talkConfig({
        enabled: true,
        baseUrl,
        botSecret: "stored-secret",
        botSecretFile: "/tmp/secret.txt",
      }),
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("replaces only the selected account's API password when the wizard sets a credential", async () => {
    const credential = expectDefined(credentials[1], "Nextcloud Talk API credential");
    const work = { baseUrl, botSecret: "work-secret", apiUser: "bot" };
    const next = await credential.applySet?.({
      cfg: talkConfig({
        botSecret: "root-secret",
        accounts: {
          work: {
            ...work,
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
      ...work,
      apiPassword: "new-password",
    });
  });
});

describe("resolveNextcloudTalkAccount", () => {
  it.runIf(process.platform !== "win32")(
    "marks symlinked botSecretFile paths configured-unavailable",
    () => {
      const secretFile = path.join(directory, "secret.txt");
      const secretLink = path.join(directory, "secret-link.txt");
      fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
      fs.symlinkSync(secretFile, secretLink);

      const account = assertUnavailableFile(secretLink);
      expect(account.credentialDiagnostics).toEqual([
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.nextcloud-talk.accounts.default.botSecretFile",
          reason: "symlink",
        },
      ]);
    },
  );

  it("does not fall through from a missing explicit bot secret file", () => {
    const secretFile = path.join(directory, "missing-secret.txt");
    assertUnavailableFile(secretFile, "inline-fallback");
  });

  it("uses configured defaultAccount for omitted setup configured state", () => {
    const configured = status.resolveConfigured({
      cfg: talkConfig({
        defaultAccount: "work",
        baseUrl: "https://root.example.com",
        botSecret: "root-secret",
        accounts: {
          alerts: { baseUrl: "https://alerts.example.com", botSecret: "alerts-secret" },
          work: { baseUrl: "", botSecret: "" },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});

describe("nextcloud-talk channel status", () => {
  it.each([
    { botSecret: "bot-secret", baseUrl: "https://cloud.example.com", configured: true },
    {
      botSecret: secretRef("MISSING_TALK_SECRET"),
      baseUrl: "https://cloud.example.com",
      configured: true,
    },
    { botSecret: undefined, baseUrl: "https://cloud.example.com", configured: false },
    { botSecret: "bot-secret", baseUrl: undefined, configured: false },
  ])("inspects webhook configuration as configured=$configured", async (entry) => {
    const cfg = talkConfig({
      accounts: { work: { botSecret: entry.botSecret, baseUrl: entry.baseUrl } },
    });
    const account = inspectNextcloudTalkAccount({ cfg, accountId: "work" });
    expect(await nextcloudTalkPlugin.config.isConfigured?.(account, cfg)).toBe(entry.configured);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: entry.configured,
      mode: "webhook",
      apiCredentialStatus: "missing",
    });
    expect(account.baseUrl).toBe(entry.baseUrl ?? "");
    expect(await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work")).toMatchObject({
      configured: entry.configured,
      baseUrl: entry.baseUrl ? "[set]" : "[missing]",
    });
  });

  it("classifies room tokens as groups", () => {
    expect(nextcloudTalkPlugin.messaging?.inferTargetChatType?.({ to: "room:abcdefgh" })).toBe(
      "group",
    );
  });

  it("surfaces missing response feature probes as config issues", () => {
    const issues = nextcloudTalkPlugin.status?.collectStatusIssues?.([
      {
        accountId: "default",
        configured: true,
        probe: {
          ok: false,
          code: "missing_response_feature",
          message: "Nextcloud Talk bot is missing --feature response.",
        },
      },
    ]);

    expect(issues).toEqual([
      {
        channel: "nextcloud-talk",
        accountId: "default",
        kind: "config",
        message: "Nextcloud Talk bot is missing --feature response.",
        fix: "Add --feature response to the Talk bot.",
      },
    ]);
  });

  it("keeps API credential inspection off runtime resolution", async () => {
    const cfg = talkConfig({
      baseUrl: "https://cloud.example.com",
      botSecret: "bot-secret",
      apiUser: "bot",
      apiPasswordFile,
    });
    const account = nextcloudTalkPlugin.config.resolveAccount(cfg, "default");
    expect(account.apiCredentialStatus).toBeUndefined();
    expect(account.credentialDiagnostics).toBeUndefined();

    fs.writeFileSync(apiPasswordFile, "api-password\n", "utf8");
    const inspected = (await nextcloudTalkPlugin.config.inspectAccount?.(
      cfg,
      "default",
    )) as typeof account;
    expect(inspected).toMatchObject({
      configured: true,
      apiCredentialStatus: "available",
      secretSource: "config",
      mode: "webhook",
      baseUrl: "[set]",
    });
    expect(nextcloudTalkPlugin.config.describeAccount?.(inspected, cfg)).toMatchObject({
      configured: true,
      apiCredentialStatus: "available",
    });
  });

  it("reports an unavailable API password ref without using a lower-priority file", async () => {
    fs.writeFileSync(apiPasswordFile, "lower-priority-password\n", "utf8");
    const settings = {
      baseUrl: "https://cloud.example.com",
      botSecret: "bot-secret",
      apiUser: "bot",
      apiPassword: secretRef("MISSING_TALK_API_PASSWORD"),
      apiPasswordFile,
    } as const;
    const cfg = talkConfig({ accounts: { work: settings } });
    expect(() => resolveNextcloudTalkApiCredentials(settings)).toThrow(/unresolved SecretRef/);
    const inspected = await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work");
    expect(inspected).toMatchObject({
      accountId: "work",
      configured: true,
      tokenStatus: "available",
      apiCredentialStatus: "configured_unavailable",
    });
    expect(JSON.stringify(inspected)).not.toContain("lower-priority-password");
  });
});
