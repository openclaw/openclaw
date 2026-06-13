// Whatsapp tests cover logout plugin behavior.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};
const WEB_LOGOUT_TEST_TIMEOUT_MS = 15_000;

describe("web logout", () => {
  let fixtureRoot = "";
  let previousOAuthDir: string | undefined;
  let caseId = 0;
  let logoutWeb: typeof import("./auth-store.js").logoutWeb;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-web-logout-"));
    previousOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_OAUTH_DIR = path.join(fixtureRoot, "oauth");
    ({ logoutWeb } = await import("./auth-store.js"));
  });

  afterAll(async () => {
    if (previousOAuthDir === undefined) {
      delete process.env.OPENCLAW_OAUTH_DIR;
    } else {
      process.env.OPENCLAW_OAUTH_DIR = previousOAuthDir;
    }
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  const makeCaseDir = async () => {
    const dir = path.join(fixtureRoot, "oauth", "whatsapp", `case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    return dir;
  };

  const makeExternalCaseDir = async () => {
    const dir = path.join(fixtureRoot, "external", `case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    return dir;
  };

  const createAuthCase = async (files: Record<string, string>) => {
    const authDir = await makeCaseDir();
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        await fsPromises.writeFile(path.join(authDir, name), contents, "utf-8");
      }),
    );
    return authDir;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "deletes credentials by default, no backup created",
    { timeout: WEB_LOGOUT_TEST_TIMEOUT_MS },
    async () => {
      const authDir = await createAuthCase({ "creds.json": "{}" });
      const result = await logoutWeb({ authDir, runtime: runtime as never });
      expect(result).toBe(true);
      // Original directory should be gone.
      expect(fs.existsSync(authDir)).toBe(false);
      // No backup should exist when backupOnClear is not set.
      const parentDir = path.dirname(authDir);
      const dirName = path.basename(authDir);
      const entries = fs.readdirSync(parentDir).filter((e) => e.startsWith(`${dirName}.bak.`));
      expect(entries.length).toBe(0);
    },
  );

  it(
    "backs up credentials instead of deleting when backupOnClear:true",
    { timeout: WEB_LOGOUT_TEST_TIMEOUT_MS },
    async () => {
      const authDir = await createAuthCase({ "creds.json": "{}" });
      const result = await logoutWeb({ authDir, backupOnClear: true, runtime: runtime as never });
      expect(result).toBe(true);
      // Original directory should no longer exist at the original path
      // (it was renamed to a timestamped backup).
      expect(fs.existsSync(authDir)).toBe(false);
      // A backup directory should have been created in the parent.
      const parentDir = path.dirname(authDir);
      const dirName = path.basename(authDir);
      const entries = fs.readdirSync(parentDir).filter((e) => e.startsWith(`${dirName}.bak.`));
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Verify the backup contains the original credential file.
      const backupDir = path.join(parentDir, entries[0]);
      expect(fs.existsSync(path.join(backupDir, "creds.json"))).toBe(true);
    },
  );

  it("backs up oauth.json too when backupOnClear:true", async () => {
    const authDir = await createAuthCase({
      "creds.json": "{}",
      "oauth.json": '{"token":true}',
      "session-abc.json": "{}",
    });
    const result = await logoutWeb({ authDir, backupOnClear: true, runtime: runtime as never });
    expect(result).toBe(true);
    // Original directory should no longer exist at the original path.
    expect(fs.existsSync(authDir)).toBe(false);
    // A backup directory should have been created in the parent with all files.
    const parentDir = path.dirname(authDir);
    const dirName = path.basename(authDir);
    const entries = fs.readdirSync(parentDir).filter((e) => e.startsWith(`${dirName}.bak.`));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const backupDir = path.join(parentDir, entries[0]);
    expect(fs.existsSync(path.join(backupDir, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "session-abc.json"))).toBe(true);
  });

  it("no-ops when nothing to delete", { timeout: WEB_LOGOUT_TEST_TIMEOUT_MS }, async () => {
    const authDir = await makeCaseDir();
    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(false);
    expect(runtime.log).toHaveBeenCalled();
  });

  it("keeps shared oauth.json when using legacy auth dir", async () => {
    const credsDir = path.join(fixtureRoot, "oauth");
    await fsPromises.mkdir(credsDir, { recursive: true });
    await fsPromises.writeFile(path.join(credsDir, "creds.json"), "{}", "utf-8");
    await fsPromises.writeFile(path.join(credsDir, "oauth.json"), '{"token":true}', "utf-8");
    await fsPromises.writeFile(path.join(credsDir, "session-abc.json"), "{}", "utf-8");

    const result = await logoutWeb({
      authDir: credsDir,
      isLegacyAuthDir: true,
      runtime: runtime as never,
    });
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(credsDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(credsDir, "creds.json"))).toBe(false);
    expect(fs.existsSync(path.join(credsDir, "session-abc.json"))).toBe(false);
  });

  it("does not delete custom auth directories outside the OpenClaw auth root", async () => {
    const authDir = await makeExternalCaseDir();
    await fsPromises.mkdir(path.join(authDir, "nested"));
    await fsPromises.writeFile(path.join(authDir, "creds.json"), "{}", "utf-8");
    await fsPromises.writeFile(path.join(authDir, "oauth.json"), '{"token":true}', "utf-8");
    await fsPromises.writeFile(path.join(authDir, "notes.txt"), "keep", "utf-8");
    await fsPromises.writeFile(path.join(authDir, "nested", "session-abc.json"), "keep", "utf-8");

    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(false);
    expect(fs.existsSync(authDir)).toBe(true);
    expect(fs.existsSync(path.join(authDir, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(authDir, "oauth.json"))).toBe(true);
    expect(fs.existsSync(path.join(authDir, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(authDir, "nested", "session-abc.json"))).toBe(true);
  });

  it("does not delete through symlinked auth dirs inside the OpenClaw auth root", async () => {
    const externalDir = await makeExternalCaseDir();
    const authDir = path.join(fixtureRoot, "oauth", "whatsapp", `case-${caseId++}`);
    await fsPromises.mkdir(path.dirname(authDir), { recursive: true });
    await fsPromises.writeFile(path.join(externalDir, "creds.json"), "{}", "utf-8");
    await fsPromises.writeFile(path.join(externalDir, "notes.txt"), "keep", "utf-8");
    await fsPromises.symlink(externalDir, authDir, "dir");

    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(false);
    expect(fs.existsSync(authDir)).toBe(true);
    expect(fs.existsSync(path.join(externalDir, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(externalDir, "notes.txt"))).toBe(true);
  });

  it("does not delete through intermediate symlinks inside the OpenClaw auth root", async () => {
    const externalRoot = path.join(fixtureRoot, "external", `case-${caseId++}`);
    const externalAuthDir = path.join(externalRoot, "default");
    const linkedParent = path.join(fixtureRoot, "oauth", "whatsapp", `linked-${caseId++}`);
    const authDir = path.join(linkedParent, "default");
    await fsPromises.mkdir(externalAuthDir, { recursive: true });
    await fsPromises.mkdir(path.dirname(linkedParent), { recursive: true });
    await fsPromises.writeFile(path.join(externalAuthDir, "creds.json"), "{}", "utf-8");
    await fsPromises.writeFile(path.join(externalAuthDir, "notes.txt"), "keep", "utf-8");
    await fsPromises.symlink(externalRoot, linkedParent, "dir");

    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(false);
    expect(fs.existsSync(authDir)).toBe(true);
    expect(fs.existsSync(path.join(externalAuthDir, "creds.json"))).toBe(true);
    expect(fs.existsSync(path.join(externalAuthDir, "notes.txt"))).toBe(true);
  });
});
