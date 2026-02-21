import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getShellConfig, resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";

describe("getShellConfig", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  const createTempBin = (files: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-"));
    tempDirs.push(dir);
    for (const name of files) {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, "");
      fs.chmodSync(filePath, 0o755);
    }
    return dir;
  };

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL", "PATH"]);
    if (!isWin) {
      process.env.SHELL = "/usr/bin/fish";
    }
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (isWin) {
    it("uses PowerShell on Windows", () => {
      const { shell } = getShellConfig();
      expect(shell.toLowerCase()).toContain("powershell");
    });
    return;
  }

  it("prefers bash when fish is default and bash is on PATH", () => {
    const binDir = createTempBin(["bash"]);
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
  });

  it("falls back to sh when fish is default and bash is missing", () => {
    const binDir = createTempBin(["sh"]);
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "sh"));
  });

  it("falls back to env shell when fish is default and no sh is available", () => {
    process.env.PATH = "";
    const { shell } = getShellConfig();
    expect(shell).toBe("/usr/bin/fish");
  });

  it("uses sh when SHELL is unset", () => {
    delete process.env.SHELL;
    process.env.PATH = "";
    const { shell } = getShellConfig();
    expect(shell).toBe("sh");
  });
});

describe("resolveShellFromPath", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  const createTempBin = (name: string, executable: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-path-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "");
    if (executable) {
      fs.chmodSync(filePath, 0o755);
    } else {
      fs.chmodSync(filePath, 0o644);
    }
    return dir;
  };

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (isWin) {
    it("returns undefined on Windows for missing PATH entries in this test harness", () => {
      process.env.PATH = "";
      expect(resolveShellFromPath("bash")).toBeUndefined();
    });
    return;
  }

  it("returns undefined when PATH is empty", () => {
    process.env.PATH = "";
    expect(resolveShellFromPath("bash")).toBeUndefined();
  });

  it("returns the first executable match from PATH", () => {
    const notExecutable = createTempBin("bash", false);
    const executable = createTempBin("bash", true);
    process.env.PATH = [notExecutable, executable].join(path.delimiter);
    expect(resolveShellFromPath("bash")).toBe(path.join(executable, "bash"));
  });

  it("returns undefined when command does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-empty-"));
    tempDirs.push(dir);
    process.env.PATH = dir;
    expect(resolveShellFromPath("bash")).toBeUndefined();
  });
});
