import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWindowsCmdShimFixture } from "../../../shared/windows-cmd-shim-test-fixtures.js";
import { resolveSpawnCommand, type SpawnCommandCache } from "./process.js";

const tempDirs: string[] = [];

function winRuntime(env: NodeJS.ProcessEnv) {
  return {
    platform: "win32" as const,
    env,
    execPath: "C:\\node\\node.exe",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-process-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 8,
    });
  }
});

describe("resolveSpawnCommand", () => {
  it("keeps non-windows spawns unchanged", () => {
    const resolved = resolveSpawnCommand(
      {
        command: "acpx",
        args: ["--help"],
      },
      undefined,
      {
        platform: "darwin",
        env: {},
        execPath: "/usr/bin/node",
      },
    );

    expect(resolved).toEqual({
      command: "acpx",
      args: ["--help"],
    });
  });

  it("routes .js command execution through node on windows", () => {
    const resolved = resolveSpawnCommand(
      {
        command: "C:/tools/acpx/cli.js",
        args: ["--help"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved.command).toBe("C:\\node\\node.exe");
    expect(resolved.args).toEqual(["C:/tools/acpx/cli.js", "--help"]);
    expect(resolved.shell).toBeUndefined();
    expect(resolved.windowsHide).toBe(true);
  });

  it("resolves a .cmd wrapper from PATH and unwraps shim entrypoint", async () => {
    const dir = await createTempDir();
    const binDir = path.join(dir, "bin");
    const scriptPath = path.join(dir, "acpx", "dist", "index.js");
    const shimPath = path.join(binDir, "acpx.cmd");
    await createWindowsCmdShimFixture({
      shimPath,
      scriptPath,
      shimLine: '"%~dp0\\..\\acpx\\dist\\index.js" %*',
    });

    const resolved = resolveSpawnCommand(
      {
        command: "acpx",
        args: ["--format", "json", "agent", "status"],
      },
      undefined,
      winRuntime({
        PATH: binDir,
        PATHEXT: ".CMD;.EXE;.BAT",
      }),
    );

    expect(resolved.command).toBe("C:\\node\\node.exe");
    expect(resolved.args[0]).toBe(scriptPath);
    expect(resolved.args.slice(1)).toEqual(["--format", "json", "agent", "status"]);
    expect(resolved.shell).toBeUndefined();
    expect(resolved.windowsHide).toBe(true);
  });

  it("prefers executable shim targets without shell", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "acpx.cmd");
    const exePath = path.join(dir, "acpx.exe");
    await writeFile(exePath, "", "utf8");
    await writeFile(wrapperPath, ["@ECHO off", '"%~dp0\\acpx.exe" %*', ""].join("\r\n"), "utf8");

    const resolved = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--help"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved).toEqual({
      command: exePath,
      args: ["--help"],
      windowsHide: true,
    });
  });

  it("falls back to shell mode when wrapper cannot be safely unwrapped", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "custom-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const resolved = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--arg", "value"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved).toEqual({
      command: wrapperPath,
      args: ["--arg", "value"],
      shell: true,
    });
  });

  it("fails closed in strict mode when wrapper cannot be safely unwrapped", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "strict-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    expect(() =>
      resolveSpawnCommand(
        {
          command: wrapperPath,
          args: ["--arg", "value"],
        },
        { strictWindowsCmdWrapper: true },
        winRuntime({}),
      ),
    ).toThrow(/without shell execution/);
  });

  it("fails closed for wrapper fallback when args include a malicious cwd payload", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "strict-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");
    const payload = "C:\\safe & calc.exe";
    const events: Array<{ resolution: string }> = [];

    expect(() =>
      resolveSpawnCommand(
        {
          command: wrapperPath,
          args: ["--cwd", payload, "agent", "status"],
        },
        {
          strictWindowsCmdWrapper: true,
          onResolved: (event) => {
            events.push({ resolution: event.resolution });
          },
        },
        winRuntime({}),
      ),
    ).toThrow(/without shell execution/);
    expect(events).toEqual([{ resolution: "unresolved-wrapper" }]);
  });

  it("reuses resolved command when cache is provided", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "acpx.cmd");
    const scriptPath = path.join(dir, "acpx", "dist", "index.js");
    await createWindowsCmdShimFixture({
      shimPath: wrapperPath,
      scriptPath,
      shimLine: '"%~dp0\\acpx\\dist\\index.js" %*',
    });

    const cache: SpawnCommandCache = {};
    const first = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--help"],
      },
      { cache },
      winRuntime({}),
    );
    await rm(scriptPath, { force: true });

    const second = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--version"],
      },
      { cache },
      winRuntime({}),
    );

    expect(first.command).toBe("C:\\node\\node.exe");
    expect(second.command).toBe("C:\\node\\node.exe");
    expect(first.args[0]).toBe(scriptPath);
    expect(second.args[0]).toBe(scriptPath);
  });
});
