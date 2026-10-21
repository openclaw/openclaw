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
const baseUrl = "https://cloud.example.com";
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

function unavailableSecret(botSecretFile: string, botSecret?: string) {
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
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(
      "URL must start with http:// or https://",
    );
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-"));
      const secretFile = path.join(dir, "secret.txt");
      const secretLink = path.join(dir, "secret-link.txt");
      fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
      fs.symlinkSync(secretFile, secretLink);

      const account = unavailableSecret(secretLink);
      expect(account.credentialDiagnostics).toEqual([
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.nextcloud-talk.accounts.default.botSecretFile",
          reason: "symlink",
        },
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it("does not fall through from a missing explicit bot secret file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-missing-"));
    const secretFile = path.join(dir, "missing-secret.txt");
    unavailableSecret(secretFile, "inline-fallback");
    fs.rmSync(dir, { recursive: true, force: true });
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
