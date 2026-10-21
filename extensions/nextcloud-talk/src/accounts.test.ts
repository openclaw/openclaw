import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

function talkConfig(config: NonNullable<CoreConfig["channels"]>["nextcloud-talk"]): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl: "https://cloud.example.com",
        botSecret: "shared-secret",
        ...config,
      },
    },
  };
}

describe("Nextcloud Talk account resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = talkConfig({ accounts: { work: { enabled: false } } });

    expect(listNextcloudTalkAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultNextcloudTalkAccountId(cfg)).toBe("default");
    expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
      accountId: "default",
      baseUrl: "https://cloud.example.com",
      secret: "shared-secret",
    });
  });

  it("inherits and overrides inbound media config through normal account resolution", () => {
    const cfg = talkConfig({
      mediaAllowFrom: ["nextcloud-talk:alice"],
      mediaMaxMb: 20,
      accounts: {
        inherited: {},
        restricted: { mediaAllowFrom: ["*"], mediaMaxMb: 5 },
      },
    });
    for (const accountId of ["default", "inherited"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId }).config).toMatchObject({
        mediaAllowFrom: ["nextcloud-talk:alice"],
        mediaMaxMb: 20,
      });
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "restricted" }).config).toMatchObject({
      mediaAllowFrom: ["*"],
      mediaMaxMb: 5,
    });
  });

  it("isolates unavailable default and named account SecretRefs from ambient credentials", () => {
    vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "ambient-secret");
    const unavailableSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_NEXTCLOUD_TALK_SECRET",
    } as const;
    const cfg = talkConfig({
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-secret-"));
    const secretFile = path.join(directory, "bot-secret");
    fs.writeFileSync(secretFile, "file-secret\n", "utf8");

    try {
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
        const cfg = talkConfig({ ...config, botSecretFile: file });
        expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({ secret, secretSource });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
