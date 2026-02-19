import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSensitivePath, resolveSandboxPath, _resetSensitivePathsCache } from "./sandbox-paths.js";

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
  const rawTmpDir = path.join(os.tmpdir(), `sandbox-sensitive-test-${process.pid}`);
  let tmpDir: string; // realpath-resolved version

  let originalHome: string | undefined;

  beforeEach(async () => {
    await fs.mkdir(rawTmpDir, { recursive: true });
    // Resolve platform symlinks (e.g. macOS /tmp -> /private/tmp) so paths
    // match what realpath returns inside the sandbox assertions.
    tmpDir = await fs.realpath(rawTmpDir);
    // Override HOME so resolveStateDir and isSensitivePath resolve against our
    // controlled dir. This ensures the test runs in CI without ~/.openclaw.
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    _resetSensitivePathsCache();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    _resetSensitivePathsCache();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("blocks symlinks that resolve to sensitive directories", async () => {
    // Create a fake .openclaw dir and a symlink pointing to it
    const fakeSensitiveDir = path.join(tmpDir, ".openclaw");
    await fs.mkdir(fakeSensitiveDir, { recursive: true });
    // Create target file so realpath can fully resolve through the symlink
    await fs.writeFile(path.join(fakeSensitiveDir, "openclaw.json"), "{}");
    const symlinkPath = path.join(tmpDir, "sneaky-link");
    await fs.symlink(fakeSensitiveDir, symlinkPath);

    await expect(
      assertSandboxPath({
        filePath: path.join("sneaky-link", "openclaw.json"),
        cwd: tmpDir,
        root: tmpDir,
      }),
    ).rejects.toThrow(/sensitive directory/);
  });

  it("allows symlinks to non-sensitive targets", async () => {
    const safeDir = path.join(tmpDir, "safe-target");
    await fs.mkdir(safeDir, { recursive: true });
    const safeLinkPath = path.join(tmpDir, "safe-link");
    await fs.symlink(safeDir, safeLinkPath);

    // Should not throw — target is not sensitive
    await assertSandboxPath({
      filePath: "safe-link",
      cwd: tmpDir,
      root: tmpDir,
    });
  });
});
