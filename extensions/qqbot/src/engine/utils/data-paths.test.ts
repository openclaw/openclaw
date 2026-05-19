import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCredentialBackupFile, getLegacyCredentialBackupFile } from "./data-paths.js";

const createdStateDirs: string[] = [];

describe("qqbot credential backup paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const stateDir of createdStateDirs.splice(0)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("scopes credential backups to the active OPENCLAW_STATE_DIR", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-state-"));
    createdStateDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expect(getCredentialBackupFile("default")).toBe(
      path.join(stateDir, "qqbot", "data", "credential-backup-default.json"),
    );
    expect(getLegacyCredentialBackupFile()).toBe(
      path.join(stateDir, "qqbot", "data", "credential-backup.json"),
    );
  });

  it("keeps same account IDs isolated across different state directories", () => {
    const stateDirA = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-state-a-"));
    const stateDirB = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-state-b-"));
    createdStateDirs.push(stateDirA, stateDirB);

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDirA);
    const gatewayAPath = getCredentialBackupFile("default");

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDirB);
    const gatewayBPath = getCredentialBackupFile("default");

    expect(gatewayAPath).toBe(
      path.join(stateDirA, "qqbot", "data", "credential-backup-default.json"),
    );
    expect(gatewayBPath).toBe(
      path.join(stateDirB, "qqbot", "data", "credential-backup-default.json"),
    );
    expect(gatewayBPath).not.toBe(gatewayAPath);
  });
});
