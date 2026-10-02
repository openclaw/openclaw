// Canvas tests cover pnpm runner plugin behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

describe("canvas pnpm runner", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "canvas pnpm runner "));
  });
  afterEach(async () => {
    if (process.platform === "win32") {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } else {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeExecutable(name: string, contents: string | Buffer, mode = 0o755) {
    const file = path.join(tempDir, name);
    writeFileSync(file, contents);
    chmodSync(file, mode);
    return file;
  }

  it.each(["pnpm", "pnpm-native"])("executes native %s from npm_execpath directly", (basename) => {
    const npmExecPath = writeExecutable(basename, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

    expect(
      resolvePnpmRunner({
        env: { PATH: "" },
        npmExecPath,
        platform: "darwin",
        pnpmArgs: ["exec", "rolldown", "-c"],
      }),
    ).toEqual({
      args: ["exec", "rolldown", "-c"],
      command: npmExecPath,
      shell: false,
    });
  });

  posixIt("falls back to bare pnpm when native npm_execpath is not executable", () => {
    const npmExecPath = writeExecutable("pnpm", Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 0o644);

    expect(
      resolvePnpmRunner({
        env: { PATH: "" },
        npmExecPath,
        platform: "darwin",
        pnpmArgs: ["exec", "rolldown", "-c"],
      }),
    ).toEqual({
      args: ["exec", "rolldown", "-c"],
      command: "pnpm",
      shell: false,
    });
  });

  posixIt("ignores a missing pnpm JS npm_execpath before checking PATH", () => {
    const corepackPath = writeExecutable("corepack", "#!/bin/sh\nexit 0\n");

    expect(
      resolvePnpmRunner({
        env: { PATH: tempDir },
        npmExecPath: path.join(tempDir, "pnpm.mjs"),
        platform: "darwin",
        pnpmArgs: ["exec", "rolldown", "-c"],
      }),
    ).toEqual({
      args: ["pnpm", "exec", "rolldown", "-c"],
      command: corepackPath,
      shell: false,
    });
  });

  posixIt("prefers a direct pnpm executable over Corepack", () => {
    const pnpmPath = writeExecutable("pnpm", "#!/bin/sh\nexit 0\n");
    writeExecutable("corepack", "#!/bin/sh\nexit 0\n");

    expect(
      resolvePnpmRunner({
        env: { PATH: tempDir },
        npmExecPath: "",
        platform: "darwin",
        pnpmArgs: ["exec", "rolldown", "-c"],
      }),
    ).toEqual({
      args: ["exec", "rolldown", "-c"],
      command: pnpmPath,
      shell: false,
    });
  });
  posixIt("launches shell npm_execpath with its own interpreter and literal arguments", () => {
    const npmExecPath = path.join(tempDir, "pnpm");
    writeFileSync(npmExecPath, "#!/bin/sh\nprintf '%s' \"$1\"\n");
    chmodSync(npmExecPath, 0o755);
    const spec = resolvePnpmRunner({ npmExecPath, pnpmArgs: ["literal & argument"] });
    const result = spawnSync(spec.command, spec.args, { encoding: "utf8", shell: spec.shell });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("literal & argument");
  });

  it.runIf(process.platform === "win32")(
    "launches native PATH entries and spaced cmd wrappers",
    async () => {
      const nativePath = path.join(tempDir, "pnpm.exe");
      copyFileSync(process.execPath, nativePath);
      const args = [
        "--eval",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "space and & literal",
      ];
      const native = resolvePnpmRunner({
        npmExecPath: "",
        env: { PATH: tempDir },
        pnpmArgs: args,
      });
      expect(native.command).toBe(nativePath);
      const result = spawnSync(native.command, native.args, {
        encoding: "utf8",
        shell: native.shell,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["space and & literal"]);
      const cmdPath = path.join(tempDir, "pnpm.cmd");
      writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" --version\r\n`);
      const cmd = resolvePnpmRunner({ npmExecPath: cmdPath });
      const cmdResult = spawnSync(cmd.command, cmd.args, {
        encoding: "utf8",
        shell: cmd.shell,
        windowsVerbatimArguments: cmd.windowsVerbatimArguments,
      });
      expect(cmdResult.status, cmdResult.stderr).toBe(0);
      expect(cmdResult.stdout.trim()).toBe(process.version);
      expect(() =>
        resolvePnpmRunner({ npmExecPath: cmdPath, pnpmArgs: ["unsafe&argument"] }),
      ).toThrow(/unsafe/);
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves literal arguments through spaced cmd wrappers",
    async () => {
      const capturePath = path.join(tempDir, "capture.cjs");
      writeFileSync(capturePath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const cmdPath = path.join(tempDir, "pnpm.cmd");
      writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${capturePath}" %*\r\n`);
      const expected = ["", "left ^ right", "C:\\two words\\", 'say "hi"'];
      const spec = resolvePnpmRunner({ npmExecPath: cmdPath, pnpmArgs: expected });

      const result = spawnSync(spec.command, spec.args, {
        encoding: "utf8",
        shell: spec.shell,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    },
  );
});
