import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  applyProfilePrefix,
  getShellConfig,
  resolvePowerShellPath,
  resolveShellFromPath,
} from "./shell-utils.js";

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
      const normalized = shell.toLowerCase();
      expect(normalized.includes("powershell") || normalized.includes("pwsh")).toBe(true);
    });

    it("includes profile sourcing when shellProfile is set on Windows", () => {
      const { args } = getShellConfig("C:\\Users\\test\\profile.ps1");
      expect(args).toContain(". 'C:\\Users\\test\\profile.ps1'; ");
    });

    it("escapes single quotes in shellProfile path on Windows", () => {
      const { args } = getShellConfig("C:\\Users\\test's\\profile.ps1");
      expect(args).toContain(". 'C:\\Users\\test''s\\profile.ps1'; ");
    });

    it("uses -NoProfile when shellProfile is not set on Windows", () => {
      const { args } = getShellConfig();
      expect(args).toContain("-NoProfile");
    });

    it("trims whitespace from shellProfile path on Windows", () => {
      const { args } = getShellConfig("  C:\\Users\\test\\profile.ps1  ");
      expect(args).toContain(". 'C:\\Users\\test\\profile.ps1'; ");
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

  it("uses source command for bash when shellProfile is set", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "bash");
    const { shell, args } = getShellConfig("/home/user/.bashrc");
    expect(shell).toBe(path.join(binDir, "bash"));
    expect(args).toContain("-c");
    expect(args).toContain(". '/home/user/.bashrc'; ");
  });

  it("ignores empty shellProfile", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "bash");
    const { args } = getShellConfig("");
    expect(args).toEqual(["-c"]);
  });

  it("ignores whitespace-only shellProfile", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "bash" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "bash");
    const { args } = getShellConfig("   ");
    expect(args).toEqual(["-c"]);
  });

  it("uses source command for zsh when shellProfile is set", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "zsh" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "zsh");
    const { shell, args } = getShellConfig("/home/user/.zshrc");
    expect(shell).toBe(path.join(binDir, "zsh"));
    expect(args).toContain("-c");
    expect(args).toContain(". '/home/user/.zshrc'; ");
  });

  it("escapes single quotes in shellProfile path for zsh", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "zsh" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "zsh");
    const { args } = getShellConfig("/home/user's/.zshrc");
    expect(args).toContain(". '/home/user'\\''s/.zshrc'; ");
  });

  it("uses source command for sh when shellProfile is set", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.PATH = binDir;
    process.env.SHELL = path.join(binDir, "sh");
    const { shell, args } = getShellConfig("/home/user/.profile");
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toContain("-c");
    expect(args).toContain(". '/home/user/.profile'; ");
  });

  it("uses source command for sh fallback when fish is default and shellProfile is set", () => {
    const binDir = createTempCommandDir(tempDirs, [{ name: "sh" }]);
    process.env.PATH = binDir;
    process.env.SHELL = "/usr/bin/fish";
    const { shell, args } = getShellConfig("/home/user/.profile");
    expect(shell).toBe(path.join(binDir, "sh"));
    expect(args).toContain("-c");
    expect(args).toContain(". '/home/user/.profile'; ");
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

describe("applyProfilePrefix", () => {
  it("merges command with Unix shell args ending with '; '", () => {
    const shellArgs = ["-c", ". '/home/user/.profile'; "];
    const command = "echo hello";
    const result = applyProfilePrefix(shellArgs, command);
    expect(result).toEqual(["-c", ". '/home/user/.profile'; echo hello"]);
  });

  it("merges command with Windows PowerShell args ending with '; '", () => {
    const shellArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ". 'C:\\Users\\test\\profile.ps1'; ",
    ];
    const command = "echo hello";
    const result = applyProfilePrefix(shellArgs, command);
    expect(result).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ". 'C:\\Users\\test\\profile.ps1'; echo hello",
    ]);
  });

  it("appends command to shell args when no profile prefix is present", () => {
    const shellArgs = ["-c"];
    const command = "echo hello";
    const result = applyProfilePrefix(shellArgs, command);
    expect(result).toEqual(["-c", "echo hello"]);
  });

  it("appends command to shell args when args do not end with '; '", () => {
    const shellArgs = ["-c", "some-other-arg"];
    const command = "echo hello";
    const result = applyProfilePrefix(shellArgs, command);
    expect(result).toEqual(["-c", "some-other-arg", "echo hello"]);
  });
});
