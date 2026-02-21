import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getShellConfig } from "./shell-utils.js";

const isWin = process.platform === "win32";

describe("Issue #12836: Shell Configuration and Script Safety", () => {
  const originalShell = process.env.SHELL;
  const originalPath = process.env.PATH;
  const tempDirs: string[] = [];

  const createTempBin = (files: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-integration-"));
    tempDirs.push(dir);
    for (const name of files) {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, "");
      fs.chmodSync(filePath, 0o755);
    }
    return dir;
  };

  afterEach(() => {
    if (originalShell == null) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore removal errors
      }
    }
  });

  if (isWin) {
    it.skip("skips shell upgrade tests on Windows (uses PowerShell)", () => {});
    return;
  }

  it("upgrades 'sh' to 'bash' if bash is available", () => {
    const binDir = createTempBin(["sh", "bash"]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "sh");

    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
  });

  it("defaults to 'bash' if SHELL is unset and bash is available", () => {
    const binDir = createTempBin(["bash"]);
    process.env.PATH = binDir;
    delete process.env.SHELL;

    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
  });

  it("falls back to 'sh' if SHELL is 'sh' and bash is missing", () => {
    const binDir = createTempBin(["sh"]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "sh");

    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
  });

  it("defaults to 'sh' if SHELL is unset and bash is missing", () => {
    const binDir = createTempBin(["sh"]);
    process.env.PATH = binDir;
    delete process.env.SHELL;

    const { shell } = getShellConfig();
    expect(shell).toBe("sh");
  });
});
