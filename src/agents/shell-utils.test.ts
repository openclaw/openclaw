import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getShellConfig, resolvePowerShellPath, resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";

function createTempCommandDir(
  tempDirs: string[],
  files: Array<{ name: string; executable?: boolean }>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-"));
  tempDirs.push(dir);
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, "");
    fs.chmodSync(filePath, file.executable === false ? 0o644 : 0o755);
  }
  return dir;
}

describe("getShellConfig", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL", "PATH", "CLAWDBOT_SHELL", "NU_VERSION", "NUSHELL_VERSION"]);
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
      const normalized = shell.toLowerCase();
      expect(normalized.includes("powershell") || normalized.includes("pwsh")).toBe(true);
    });
    return;
  }

  it("prefers bash when fish is default and bash is on PATH", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
  });

  it("falls back to sh when fish is default and bash is missing", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
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

  it("uses nushell directly when SHELL is nu", () => {
    process.env.SHELL = "/usr/bin/nu";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/nu");
    expect(args).toEqual(["-c"]);
  });

  it("detects nushell via NU_VERSION when SHELL is bash", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "nu" }]);
    process.env.SHELL = "/usr/bin/bash";
    process.env.NU_VERSION = "0.111.0";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "nu"));
    expect(args).toEqual(["-c"]);
  });

  it("uses CLAWDBOT_SHELL override with absolute path", () => {
    process.env.CLAWDBOT_SHELL = "/usr/bin/nu";
    process.env.SHELL = "/usr/bin/bash";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/nu");
    expect(args).toEqual(["-c"]);
  });

  it("resolves CLAWDBOT_SHELL name from PATH", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "nu" }]);
    process.env.CLAWDBOT_SHELL = "nu";
    process.env.SHELL = "/usr/bin/bash";
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "nu"));
  });

  it("CLAWDBOT_SHELL takes precedence over SHELL", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "zsh" }]);
    process.env.CLAWDBOT_SHELL = "zsh";
    process.env.SHELL = "/usr/bin/nu";
    process.env.PATH = binDir;
    const { shell } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "zsh"));
  });

  it("CLAWDBOT_SHELL=fish falls back to bash like default path", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.CLAWDBOT_SHELL = "/usr/bin/fish";
    process.env.SHELL = "/usr/bin/bash";
    process.env.PATH = binDir;
    const { shell, args } = getShellConfig();
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toEqual(["-c"]);
  });

  it("CLAWDBOT_SHELL=pwsh uses PowerShell safeguard args", () => {
    process.env.CLAWDBOT_SHELL = "/usr/bin/pwsh";
    process.env.SHELL = "/usr/bin/bash";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/pwsh");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("CLAWDBOT_SHELL=pwsh bare name uses resolvePowerShellPath discovery", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "pwsh" }]);
    process.env.CLAWDBOT_SHELL = "pwsh";
    process.env.SHELL = "/usr/bin/bash";
    process.env.PATH = binDir;
    const { args } = getShellConfig();
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("CLAWDBOT_SHELL=cmd uses /c instead of -c", () => {
    process.env.CLAWDBOT_SHELL = "/usr/bin/cmd";
    process.env.SHELL = "/usr/bin/bash";
    const { shell, args } = getShellConfig();
    expect(shell).toBe("/usr/bin/cmd");
    expect(args).toEqual(["/c"]);
  });

  it("normalizes SHELL with extension for nushell detection", () => {
    // normalizeShellName strips .cmd/.exe so "nu.cmd" is detected as "nu"
    process.env.SHELL = "/usr/bin/nu.cmd";
    const { args } = getShellConfig();
    expect(args).toEqual(["-c"]);
  });
});

describe("resolveShellFromPath", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when PATH is empty", () => {
    process.env.PATH = "";
    expect(resolveShellFromPath("bash")).toBeUndefined();
  });

  if (isWin) {
    return;
  }

  it("returns the first executable match from PATH", () => {
    const notExecutable = createTempCommandDir(tempDirs, [{ name: "bash", executable: false }]);
    const executable = createTempCommandDir(tempDirs, [{ name: "bash", executable: true }]);
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

describe("resolvePowerShellPath", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    envSnapshot = captureEnv([
      "ProgramFiles",
      "PROGRAMFILES",
      "ProgramW6432",
      "SystemRoot",
      "WINDIR",
      "PATH",
    ]);
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers PowerShell 7 in ProgramFiles", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    tempDirs.push(base);
    const pwsh7Dir = path.join(base, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = base;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwsh7Path);
  });

  it("prefers ProgramW6432 PowerShell 7 when ProgramFiles lacks pwsh", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const programW6432 = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pw6432-"));
    tempDirs.push(programFiles, programW6432);
    const pwsh7Dir = path.join(programW6432, "PowerShell", "7");
    fs.mkdirSync(pwsh7Dir, { recursive: true });
    const pwsh7Path = path.join(pwsh7Dir, "pwsh.exe");
    fs.writeFileSync(pwsh7Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.ProgramW6432 = programW6432;
    process.env.PATH = "";
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwsh7Path);
  });

  it("finds pwsh on PATH when not in standard install locations", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bin-"));
    tempDirs.push(programFiles, binDir);
    const pwshPath = path.join(binDir, "pwsh");
    fs.writeFileSync(pwshPath, "");
    fs.chmodSync(pwshPath, 0o755);

    process.env.ProgramFiles = programFiles;
    process.env.PATH = binDir;
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(pwshPath);
  });

  it("falls back to Windows PowerShell 5.1 path when pwsh is unavailable", () => {
    const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pfiles-"));
    const sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sysroot-"));
    tempDirs.push(programFiles, sysRoot);
    const ps51Dir = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0");
    fs.mkdirSync(ps51Dir, { recursive: true });
    const ps51Path = path.join(ps51Dir, "powershell.exe");
    fs.writeFileSync(ps51Path, "");

    process.env.ProgramFiles = programFiles;
    process.env.SystemRoot = sysRoot;
    process.env.PATH = "";
    delete process.env.ProgramW6432;
    delete process.env.WINDIR;

    expect(resolvePowerShellPath()).toBe(ps51Path);
  });
});
