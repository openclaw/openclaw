import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCredentialBackup, saveCredentialBackup } from "./credential-backup.js";

describe("engine/config/credential-backup", () => {
  const acct = `test-cb-${process.pid}-${Date.now()}`;
  let previousStateDir: string | undefined;
  let stateRoot = "";

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-credential-backup-"));
    process.env.OPENCLAW_STATE_DIR = path.join(stateRoot, ".openclaw");
    resetPluginStateStoreForTests();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("round-trips a credential snapshot", () => {
    saveCredentialBackup(acct, "app-1", "secret-1");
    const loaded = loadCredentialBackup(acct);
    expect(loaded?.appId).toBe("app-1");
    expect(loaded?.clientSecret).toBe("secret-1");
    expect(loaded?.accountId).toBe(acct);
    expect(fs.existsSync(path.join(stateRoot, ".openclaw", "state", "openclaw.sqlite"))).toBe(true);
  });

  it("returns null when no backup exists", () => {
    expect(loadCredentialBackup(acct)).toBeNull();
  });

  it("ignores empty appId/clientSecret on save", () => {
    saveCredentialBackup(acct, "", "secret");
    saveCredentialBackup(acct, "app", "");
    expect(loadCredentialBackup(acct)).toBeNull();
  });
});
