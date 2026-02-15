import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSensitivePath, resolveSandboxPath } from "./sandbox-paths.js";

// Dynamic import for assertSandboxPath (async version)
const { assertSandboxPath } = await import("./sandbox-paths.js");

const home = os.homedir();

describe("isSensitivePath", () => {
  it("blocks ~/.openclaw/openclaw.json", () => {
    const result = isSensitivePath(path.join(home, ".openclaw", "openclaw.json"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.openclaw/credentials/", () => {
    const result = isSensitivePath(path.join(home, ".openclaw", "credentials", "token.json"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.openclaw/ itself", () => {
    const result = isSensitivePath(path.join(home, ".openclaw"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.ssh/id_rsa", () => {
    const result = isSensitivePath(path.join(home, ".ssh", "id_rsa"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.gnupg/", () => {
    const result = isSensitivePath(path.join(home, ".gnupg", "secring.gpg"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.aws/credentials", () => {
    const result = isSensitivePath(path.join(home, ".aws", "credentials"));
    expect(result.sensitive).toBe(true);
  });

  it("allows normal workspace paths", () => {
    const result = isSensitivePath(path.join(home, "workspace", "project", "index.ts"));
    expect(result.sensitive).toBe(false);
  });

  it("allows paths outside home", () => {
    const result = isSensitivePath("/tmp/test.txt");
    expect(result.sensitive).toBe(false);
  });

  it("allows home directory root files", () => {
    const result = isSensitivePath(path.join(home, ".bashrc"));
    expect(result.sensitive).toBe(false);
  });
});

describe("resolveSandboxPath sensitive path blocking", () => {
  it("throws when accessing ~/.openclaw/ within sandbox", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: ".openclaw/openclaw.json",
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("throws when accessing ~/.ssh/ within sandbox", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: ".ssh/id_rsa",
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("allows normal paths within sandbox", () => {
    const result = resolveSandboxPath({
      filePath: "workspace/file.ts",
      cwd: home,
      root: home,
    });
    expect(result.resolved).toContain("workspace/file.ts");
  });

  it("allows skipping sensitive check when flag is set", () => {
    // Should not throw
    const result = resolveSandboxPath({
      filePath: ".openclaw/openclaw.json",
      cwd: home,
      root: home,
      skipSensitiveCheck: true,
    });
    expect(result.resolved).toContain(".openclaw/openclaw.json");
  });

  it("blocks absolute paths targeting sensitive dirs", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: path.join(home, ".openclaw", "credentials", "key.json"),
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("blocks tilde-expanded paths targeting sensitive dirs", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: "~/.openclaw/openclaw.json",
        cwd: "/tmp",
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });
});

describe("assertSandboxPath symlink-aware sensitive path blocking", () => {
  const tmpDir = path.join(os.tmpdir(), `sandbox-sensitive-test-${process.pid}`);
  const symlinkPath = path.join(tmpDir, "sneaky-link");
  const openclawDir = path.join(home, ".openclaw");

  beforeAll(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    // Only create symlink if .openclaw exists (it should on most dev machines)
    try {
      await fs.stat(openclawDir);
      await fs.symlink(openclawDir, symlinkPath);
    } catch {
      // .openclaw doesn't exist — skip symlink creation, test will be skipped
    }
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("blocks symlinks that resolve to sensitive directories", async () => {
    try {
      await fs.lstat(symlinkPath);
    } catch {
      return; // skip if symlink wasn't created
    }

    await expect(
      assertSandboxPath({
        filePath: path.join("sneaky-link", "openclaw.json"),
        cwd: tmpDir,
        root: tmpDir,
      }),
    ).rejects.toThrow(/sensitive directory/);
  });

  it("allows symlinks to non-sensitive targets", async () => {
    const safeLinkTarget = tmpDir; // points to itself, not sensitive
    const safeLinkPath = path.join(tmpDir, "safe-link");
    try {
      await fs.symlink(safeLinkTarget, safeLinkPath);
    } catch {
      return;
    }

    // Should not throw — target is not sensitive
    await assertSandboxPath({
      filePath: "safe-link",
      cwd: tmpDir,
      root: tmpDir,
    });
  });
});
