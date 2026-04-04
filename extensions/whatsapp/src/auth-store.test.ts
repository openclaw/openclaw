import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./auth-store.runtime.js", () => ({
  resolveOAuthDir: () => "/tmp/openclaw-oauth",
}));

describe("maybeRestoreCredsFromBackup", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let maybeRestoreCredsFromBackup: typeof import("./auth-store.js").maybeRestoreCredsFromBackup;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-creds-restore-"));
    ({ maybeRestoreCredsFromBackup } = await import("./auth-store.js"));
  });

  afterAll(async () => {
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  const makeCaseDir = async () => {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    return dir;
  };

  it("does not restore when creds.json is valid JSON", async () => {
    const dir = await makeCaseDir();
    const credsPath = path.join(dir, "creds.json");
    const backupPath = path.join(dir, "creds.json.bak");
    const validCreds = JSON.stringify({ me: { id: "123@s.whatsapp.net" } });
    fsSync.writeFileSync(credsPath, validCreds);
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "old@s.whatsapp.net" } }));

    maybeRestoreCredsFromBackup(dir);

    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(validCreds);
  });

  it("restores from backup when creds.json is truly absent", async () => {
    const dir = await makeCaseDir();
    const credsPath = path.join(dir, "creds.json");
    const backupPath = path.join(dir, "creds.json.bak");
    const backupContent = JSON.stringify({ me: { id: "backup@s.whatsapp.net" } });
    fsSync.writeFileSync(backupPath, backupContent);
    // creds.json does not exist

    maybeRestoreCredsFromBackup(dir);

    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(backupContent);
  });

  it("skips restore when creds.json exists but is empty (transient write)", async () => {
    const dir = await makeCaseDir();
    const credsPath = path.join(dir, "creds.json");
    const backupPath = path.join(dir, "creds.json.bak");
    const backupContent = JSON.stringify({ me: { id: "backup@s.whatsapp.net" } });
    // Simulate transient truncation during concurrent saveCreds() write
    fsSync.writeFileSync(credsPath, "");
    fsSync.writeFileSync(backupPath, backupContent);

    maybeRestoreCredsFromBackup(dir);

    // creds.json should NOT be overwritten — the empty state is transient
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("");
  });

  it("skips restore when creds.json is a single byte (transient write)", async () => {
    const dir = await makeCaseDir();
    const credsPath = path.join(dir, "creds.json");
    const backupPath = path.join(dir, "creds.json.bak");
    fsSync.writeFileSync(credsPath, "{");
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "backup@s.whatsapp.net" } }));

    maybeRestoreCredsFromBackup(dir);

    // Single-byte file on disk means write in progress — don't clobber
    expect(fsSync.readFileSync(credsPath, "utf-8")).toBe("{");
  });

  it("does nothing when neither file exists", async () => {
    const dir = await makeCaseDir();

    // Should not throw
    maybeRestoreCredsFromBackup(dir);

    expect(fsSync.existsSync(path.join(dir, "creds.json"))).toBe(false);
  });
});
