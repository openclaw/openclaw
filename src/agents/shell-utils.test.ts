import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellConfig } from "./shell-utils.js";

const isWin = process.platform === "win32";

describe("getShellConfig", () => {
  const originalShell = process.env.SHELL;
  const originalPath = process.env.PATH;
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
    if (!isWin) {
      process.env.SHELL = "/usr/bin/fish";
    }
  });

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
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (isWin) {
    it("uses PowerShell on Windows", () => {
      const { shell } = getShellConfig();
      expect(shell.toLowerCase()).toContain("powershell");
    });
  }

  it("uses custom shell when override.shell is provided", () => {
    const customShell = isWin
      ? "d:\\Program Files\\Git\\bin\\bash.exe"
      : "/usr/local/bin/custom-bash";
    const { shell, args } = getShellConfig({ shell: customShell });
    expect(shell).toBe(customShell);
    expect(args).toEqual(["-c"]);
  });

  it("auto-detects args for bash-like shells", () => {
    const { args } = getShellConfig({ shell: "/usr/bin/bash" });
    expect(args).toEqual(["-c"]);
  });

  it("auto-detects args for powershell override", () => {
    const { args } = getShellConfig({
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("auto-detects args for pwsh override", () => {
    const { args } = getShellConfig({ shell: "/usr/local/bin/pwsh" });
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("uses explicit shellArgs when provided", () => {
    const customArgs = ["-l", "-c"];
    const { shell, args } = getShellConfig({ shell: "/bin/bash", shellArgs: customArgs });
    expect(shell).toBe("/bin/bash");
    expect(args).toEqual(customArgs);
  });

  it("honors shellArgs override even when shell is not overridden", () => {
    const customArgs = ["-l", "-c"];
    const { shell, args } = getShellConfig({ shellArgs: customArgs });
    if (isWin) {
      expect(shell.toLowerCase()).toContain("powershell");
    } else {
      expect(typeof shell).toBe("string");
    }
    expect(args).toEqual(customArgs);
  });

  it("falls back to platform default when override.shell is undefined", () => {
    const { shell } = getShellConfig({ shell: undefined });
    if (isWin) {
      expect(shell.toLowerCase()).toContain("powershell");
    } else {
      // Falls through to the normal logic
      expect(typeof shell).toBe("string");
    }
  });

  if (isWin) {
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
