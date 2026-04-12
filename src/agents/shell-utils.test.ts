import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  detectRuntimeShell,
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
    envSnapshot = captureEnv([
      "OPENCLAW_SHELL",
      "SHELL",
      "PATH",
      "POWERSHELL_DISTRIBUTION_CHANNEL",
    ]);
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

    it("prefers OPENCLAW_SHELL over SHELL on Windows", () => {
      process.env.OPENCLAW_SHELL = "C:\\Program Files\\Git\\bin\\bash.exe";
      process.env.SHELL = "cmd.exe";

      expect(getShellConfig()).toEqual({
        shell: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["-c"],
      });
    });

    it("strips paired quotes from configured Windows shell paths", () => {
      process.env.OPENCLAW_SHELL = '"C:\\Program Files\\Git\\bin\\bash.exe"';

      expect(getShellConfig()).toEqual({
        shell: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["-c"],
      });
    });

    it("falls back to SHELL when OPENCLAW_SHELL is an invalid POSIX path", () => {
      process.env.OPENCLAW_SHELL = "/usr/bin/bash";
      process.env.SHELL = "cmd.exe";

      expect(getShellConfig()).toEqual({
        shell: "cmd.exe",
        args: ["/c"],
      });
    });

    it("ignores non-shell OPENCLAW_SHELL markers on Windows", () => {
      process.env.OPENCLAW_SHELL = "exec";
      process.env.SHELL = "pwsh";

      expect(getShellConfig()).toEqual({
        shell: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
      });
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

describe("detectRuntimeShell", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_SHELL",
      "SHELL",
      "POWERSHELL_DISTRIBUTION_CHANNEL",
      "BASH_VERSION",
      "ZSH_VERSION",
      "FISH_VERSION",
      "KSH_VERSION",
      "NU_VERSION",
      "NUSHELL_VERSION",
    ]);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  if (isWin) {
    it("reports the configured custom shell on Windows", () => {
      process.env.OPENCLAW_SHELL = "C:\\Program Files\\Git\\bin\\bash.exe";

      expect(detectRuntimeShell()).toBe("bash");
    });

    it("detects quoted custom shell paths on Windows", () => {
      process.env.OPENCLAW_SHELL = '"C:\\Program Files\\Git\\bin\\bash.exe"';

      expect(detectRuntimeShell()).toBe("bash");
    });

    it("falls back to SHELL when OPENCLAW_SHELL is invalid on Windows", () => {
      process.env.OPENCLAW_SHELL = "/usr/bin/bash";
      process.env.SHELL = "pwsh";

      expect(detectRuntimeShell()).toBe("pwsh");
    });

    it("ignores non-shell OPENCLAW_SHELL markers when detecting runtime shell on Windows", () => {
      process.env.OPENCLAW_SHELL = "exec";
      process.env.SHELL = "cmd.exe";

      expect(detectRuntimeShell()).toBe("cmd");
    });

    it("falls back to PowerShell detection on Windows", () => {
      delete process.env.OPENCLAW_SHELL;
      delete process.env.SHELL;
      process.env.POWERSHELL_DISTRIBUTION_CHANNEL = "OpenClaw";

      expect(detectRuntimeShell()).toBe("pwsh");
    });
    return;
  }

  it("prefers OPENCLAW_SHELL on non-Windows", () => {
    process.env.OPENCLAW_SHELL = "/bin/zsh";
    process.env.SHELL = "/bin/bash";

    expect(detectRuntimeShell()).toBe("zsh");
  });

  it("falls back to environment markers on non-Windows", () => {
    delete process.env.OPENCLAW_SHELL;
    delete process.env.SHELL;
    process.env.NU_VERSION = "0.98.0";

    expect(detectRuntimeShell()).toBe("nu");
  });
});
