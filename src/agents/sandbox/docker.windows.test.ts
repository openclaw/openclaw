import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDockerSpawnInvocation } from "./docker.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-docker-spawn-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveDockerSpawnInvocation", () => {
  it("keeps non-windows invocation unchanged", () => {
    const resolved = resolveDockerSpawnInvocation(["version"], {
      platform: "darwin",
      env: {},
      execPath: "/usr/bin/node",
    });
    expect(resolved).toEqual({
      command: "docker",
      args: ["version"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("prefers docker.exe entrypoint over cmd shell fallback on windows", async () => {
    const dir = await createTempDir();
    const exePath = path.join(dir, "docker.exe");
    const cmdPath = path.join(dir, "docker.cmd");
    await writeFile(exePath, "", "utf8");
    await writeFile(cmdPath, `@ECHO off\r\n"%~dp0\\docker.exe" %*\r\n`, "utf8");

    const resolved = resolveDockerSpawnInvocation(["version"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: exePath,
      args: ["version"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("falls back to shell mode when only unresolved docker.cmd wrapper exists", async () => {
    const dir = await createTempDir();
    const cmdPath = path.join(dir, "docker.cmd");
    await mkdir(path.dirname(cmdPath), { recursive: true });
    await writeFile(cmdPath, "@ECHO off\r\necho docker\r\n", "utf8");

    const resolved = resolveDockerSpawnInvocation(["ps"], {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });
    expect(path.normalize(resolved.command).toLowerCase()).toBe(
      path.normalize(cmdPath).toLowerCase(),
    );
    expect(resolved.args).toEqual(["ps"]);
    expect(resolved.shell).toBe(true);
    expect(resolved.windowsHide).toBeUndefined();
  });
});
