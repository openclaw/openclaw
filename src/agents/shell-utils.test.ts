import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  buildShellCommandInvocation,
  createStreamingBinaryOutputSanitizer,
  detectRuntimeShell,
  getBashShellConfig,
  getBashShellEnv,
  getShellConfig,
  sanitizeBinaryOutput,
} from "./shell-utils.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Whole-module autospy mutates native ChildProcess prototypes across shared-worker files.
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const isWin = process.platform === "win32";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let envSnapshot: ReturnType<typeof captureEnv>;
const runtimeHints = [
  "OPENCLAW_SHELL",
  "POWERSHELL_DISTRIBUTION_CHANNEL",
  "BASH_VERSION",
  "ZSH_VERSION",
  "FISH_VERSION",
  "KSH_VERSION",
  "NU_VERSION",
  "NUSHELL_VERSION",
];
beforeEach(() => {
  vi.mocked(spawnSync).mockClear();
  envSnapshot = captureEnv([
    "SHELL",
    "PATH",
    "Path",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PROGRAMFILES",
    "ProgramW6432",
    "SystemRoot",
    "WINDIR",
    ...runtimeHints,
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  envSnapshot.restore();
});
function writeCommand(root: string, relativePath: string, executable = false) {
  const command = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, "");
  if (executable) {
    fs.chmodSync(command, 0o755);
  }
  return command;
}

describe("sanitizeBinaryOutput", () => {
  it.each([
    [["\u001b[31mred\u001b[0m"], "red"],
    [["\u009b31mred\u009b0m"], "red"],
    [["\u001b]unterminated"], "\\x1b]unterminated"],
    [["before\u009b31;"], "before\\x9b31;"],
    [["\u001b[", "Ksecret"], "\\x1b[Ksecret"],
    // SOH executes independently, then "d" terminates CSI as its final byte.
    [["\u009b\u0001done"], "\\x01one"],
    [["\u009b31\u0018done"], "done"],
    [["\u001b[31\u001adone"], "done"],
    [["a\u0000\u0007\u007f\u0080b\t\n"], "a\\x00\\x07\\x7f\\x80b\t\n"],
  ] as const)("sanitizes controls independently across chunks %j", (chunks, expected) => {
    expect(chunks.map((text) => sanitizeBinaryOutput(text)).join("")).toBe(expected);
  });

  it.each(["report-👩\u200d💻.json"])("preserves Unicode joiners in command output: %s", (text) => {
    expect(sanitizeBinaryOutput(text)).toBe(text);
    expect(sanitizeBinaryOutput(text, { ansiMode: "compat" })).toBe(text);

    const sanitize = createStreamingBinaryOutputSanitizer();
    const chunks = ["\u001b[3", "2m", ...Array.from(text), "\u001b[", "0m"];
    expect(chunks.map(sanitize).join("")).toBe(text);
  });

  it("still removes other format characters and lone surrogates", () => {
    const text = "a\u200bb\u202ec\u2066d\u2069e\ufefff\ud800g\udc00h\u0000";
    const expected = "abcdefgh\\x00";
    expect(sanitizeBinaryOutput(text)).toBe(expected);
    expect(createStreamingBinaryOutputSanitizer()(text)).toBe(expected);
  });
  it("carries ANSI state across process-output chunks", () => {
    const sanitize = createStreamingBinaryOutputSanitizer();

    expect(["A\u001b]0;title", "\u0007B\u001b[31", "mC"].map(sanitize)).toEqual(["A", "B", "C"]);
  });
});

function createTempCommandDir(name: string): string {
  const dir = tempDirs.make("openclaw-shell-");
  writeCommand(dir, name, true);
  return dir;
}

type ShellConfig = ReturnType<typeof getBashShellConfig>;

describe("getShellConfig", () => {
  if (isWin) {
    it("uses PowerShell on Windows", () => {
      expect(getShellConfig()).toMatchObject({
        shell: expect.stringMatching(/powershell|pwsh/i),
        args: ["-NoProfile", "-NonInteractive", "-Command"],
      });
    });
    return;
  }

  it.each([
    { envShell: "/usr/bin/fish", binary: "bash", args: ["--noprofile", "--norc", "-c"] },
    { envShell: "/usr/bin/fish", binary: "sh", args: ["-c"] },
    { envShell: "/usr/bin/fish", binary: "", args: ["--no-config", "-c"] },
    { envShell: "/bin/zsh", binary: "", args: ["-f", "-c"] },
    { envShell: "/bin/bash", binary: "", args: ["--noprofile", "--norc", "-c"] },
    { envShell: undefined, binary: "", args: ["-c"] },
    { envShell: "/usr/bin/false", binary: "sh", args: ["-c"] },
    { envShell: "/usr/bin/false", binary: "bash", args: ["--noprofile", "--norc", "-c"] },
    { envShell: "/usr/bin/false", binary: "", args: ["-c"] },
  ])("resolves SHELL=$envShell with PATH binary '$binary'", ({ envShell, binary, args }) => {
    if (envShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = envShell;
    }
    const binDir = binary ? createTempCommandDir(binary) : "";
    process.env.PATH = binDir;
    expect(getShellConfig()).toEqual({
      shell: binary
        ? path.join(binDir, binary)
        : envShell && envShell !== "/usr/bin/false"
          ? envShell
          : "sh",
      args,
      commandTransport: "argv",
    });
  });

  it("uses an explicit custom shell path through the same resolver", () => {
    const binDir = createTempCommandDir("zsh");
    const shellPath = path.join(binDir, "zsh");

    expect(getShellConfig(shellPath)).toEqual({
      shell: shellPath,
      args: ["-f", "-c"],
      commandTransport: "argv",
    });
  });

  it("rejects a missing explicit custom shell path", () => {
    expect(() => getShellConfig(path.join(os.tmpdir(), "missing-openclaw-shell"))).toThrow(
      "Custom shell path not found",
    );
  });
});

describe.skipIf(isWin)("getBashShellConfig POSIX discovery", () => {
  it("matches which cwd discovery for empty PATH entries without spawning a resolver", () => {
    const root = tempDirs.make("openclaw-shell-cwd-");
    fs.writeFileSync(path.join(root, "bash"), "", { mode: 0o755 });
    const expected = execFileSync("/usr/bin/which", ["bash"], {
      cwd: root,
      env: { PATH: ":" },
      encoding: "utf8",
    }).trim();
    vi.stubEnv("PATH", ":");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(path.resolve(root, getBashShellConfig().shell)).toBe(path.resolve(root, expected));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("falls back to sh without spawning which when bash is unavailable", () => {
    const root = tempDirs.make("openclaw-shell-no-bash-");
    fs.writeFileSync(path.join(root, "sh"), "", { mode: 0o755 });
    vi.stubEnv("PATH", root);
    const existsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
      candidate === "/bin/bash" ? false : existsSync(candidate),
    );

    expect(getBashShellConfig()).toEqual({
      shell: path.join(root, "sh"),
      args: ["-c"],
      commandTransport: "argv",
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("getBashShellConfig", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  it("finds Git Bash under ProgramFiles", () => {
    const programFiles = tempDirs.make("openclaw-git-bash-");
    const bashPath = writeCommand(programFiles, "Git/bin/bash.exe");

    process.env.ProgramFiles = programFiles;
    process.env.PATH = "";

    expect(getBashShellConfig()).toEqual({
      shell: bashPath,
      args: ["-c"],
      commandTransport: "argv",
    });
  });

  it.each(["bin", "usr/bin"])("prepends coreutils for Git Bash installed in %s", (shellDir) => {
    const programFiles = tempDirs.make("openclaw-git-bash-env-");
    const gitRoot = path.join(programFiles, "Git");
    const bashPath = writeCommand(gitRoot, `${shellDir}/bash.exe`);
    const usrBin = path.join(gitRoot, "usr", "bin");
    fs.mkdirSync(usrBin, { recursive: true });
    writeCommand(gitRoot, "cmd/git.exe");
    process.env.PATH = path.join(programFiles, "OtherBin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(usrBin);
    expect(env.PATH).toContain(process.env.PATH);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
  });

  it("leaves unrelated MSYS2 installs unchanged", () => {
    const msysRoot = tempDirs.make("openclaw-msys2-");
    const bashPath = writeCommand(msysRoot, "usr/bin/bash.exe");
    process.env.PATH = path.join(msysRoot, "ucrt64", "bin");

    const env = getBashShellEnv(bashPath);

    expect(env.PATH?.split(path.delimiter)[0]).not.toBe(path.dirname(bashPath));
    expect(env.PATH).toContain(process.env.PATH);
  });

  it.each(["System32", "Sysnative"])(
    "uses stdin transport for the legacy %s WSL launcher",
    (systemDirectory) => {
      const shellPath = `C:\\Windows\\${systemDirectory}\\bash.exe`;
      vi.spyOn(fs, "existsSync").mockImplementation((candidate) => String(candidate) === shellPath);

      expect(getBashShellConfig(shellPath)).toEqual({
        shell: shellPath,
        args: ["-s"],
        commandTransport: "stdin",
      });
    },
  );

  it.each<{ config: ShellConfig; expected: ReturnType<typeof buildShellCommandInvocation> }>([
    {
      config: { shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" },
      expected: {
        argv: ["C:\\Windows\\System32\\bash.exe", "-s"],
        input: "printf ready",
        stdin: "pipe",
      },
    },
    {
      config: { shell: "/bin/bash", args: ["-c"], commandTransport: "argv" },
      expected: { argv: ["/bin/bash", "-c", "printf ready"], stdin: "ignore" },
    },
  ])("builds a $config.commandTransport invocation", ({ config, expected }) => {
    expect(buildShellCommandInvocation("printf ready", config)).toEqual(expected);
  });
});

describe("getBashShellEnv", () => {
  it("returns an env object with the OpenClaw bin dir on PATH", () => {
    process.env.PATH = "/usr/bin";
    const env = getBashShellEnv();

    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain(".openclaw");
  });

  it("collapses case-insensitive PATH duplicates before Windows spawn", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const env = getBashShellEnv(undefined, { PATH: "/selected", Path: "/discarded" });

    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toContain("/selected");
    expect(env.PATH).not.toContain("/discarded");
  });

  it.runIf(isWin)("passes one canonical PATH entry to a child process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => key.toLowerCase() === 'path')))",
      ],
      { encoding: "utf8", env: getBashShellEnv() },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["PATH"]);
  });
});

it.runIf(!isWin)(
  "detectRuntimeShell ignores non-interactive SHELL and falls through to runtime hints",
  () => {
    for (const key of runtimeHints) {
      delete process.env[key];
    }
    process.env.SHELL = "/usr/bin/false";
    process.env.BASH_VERSION = "5.2.0";

    expect(detectRuntimeShell()).toBe("bash");
  },
);

describe("getShellConfig on Windows", () => {
  let programFiles: string;
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    delete process.env.ProgramW6432;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;
    programFiles = tempDirs.make("openclaw-pfiles-");
    process.env.ProgramFiles = programFiles;
    process.env.PATH = "";
  });

  it.each(["ProgramFiles", "ProgramW6432"] as const)("finds PowerShell 7 in %s", (installEnv) => {
    const programW6432 = tempDirs.make("openclaw-pw6432-");
    const pwsh7Path = writeCommand(
      installEnv === "ProgramFiles" ? programFiles : programW6432,
      "PowerShell/7/pwsh.exe",
    );

    process.env.ProgramW6432 = programW6432;

    expect(getShellConfig().shell).toBe(pwsh7Path);
  });

  it("finds pwsh on PATH when not in standard install locations", () => {
    const binDir = createTempCommandDir("pwsh");
    const pwshPath = path.join(binDir, "pwsh");

    process.env.PATH = binDir;

    expect(getShellConfig().shell).toBe(pwshPath);
  });

  it("prefers a native pwsh.exe over earlier bare shims, batch wrappers, and PowerShell 5.1", () => {
    const shimDir = createTempCommandDir("pwsh");
    const binDir = createTempCommandDir("pwsh.exe");
    const systemRoot = tempDirs.make("openclaw-sysroot-");
    const pwshPath = path.join(binDir, "pwsh.exe");
    writeCommand(binDir, "pwsh.cmd", true);
    writeCommand(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");

    process.env.SystemRoot = systemRoot;
    process.env.PATH = [shimDir, binDir].join(path.delimiter);

    expect(getShellConfig().shell).toBe(pwshPath);
  });

  it("falls back to Windows PowerShell 5.1 path when pwsh is unavailable", () => {
    const sysRoot = tempDirs.make("openclaw-sysroot-");
    const ps51Path = writeCommand(sysRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");

    process.env.SystemRoot = sysRoot;

    expect(getShellConfig().shell).toBe(ps51Path);
  });
});
