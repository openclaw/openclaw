// Microsoft Foundry tests cover real local az substitute process behavior.
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnedChildren = vi.hoisted(() => [] as ChildProcess[]);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnedChildren.push(child);
      return child;
    }),
  };
});

import { azLoginDeviceCodeWithOptions } from "./cli.js";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  // openclaw-temp-dir: allow extension proof tests cannot import root test helpers.
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installFakeAzExecutable(options?: { ignoreSigterm?: boolean; pidFile?: string }): void {
  const binDir = makeTempDir("openclaw-foundry-az-");
  const scriptPath = path.join(binDir, "fake-az.mjs");
  const sigtermHandler = options?.ignoreSigterm
    ? "process.on('SIGTERM', () => {});"
    : ["process.on('SIGTERM', () => {", "  process.exit(0);", "});"].join("\n");
  const pidRecorder = options?.pidFile
    ? [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(options.pidFile)}, String(process.pid));`,
      ].join("\n")
    : "";
  writeFileSync(
    scriptPath,
    [
      pidRecorder,
      sigtermHandler,
      "process.stderr.write('ready\\n');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    {
      mode: 0o755,
    },
  );

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "az.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    const azPath = path.join(binDir, "az");
    writeFileSync(azPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(azPath, 0o755);
  }

  process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);
}

function requireSpawnedChild(): ChildProcess {
  const child = spawnedChildren.at(-1);
  if (!child) {
    throw new Error("Expected az login to spawn a child process");
  }
  return child;
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
  if (!child.stderr) {
    throw new Error("Expected az substitute stderr pipe");
  }
  await once(child.stderr, "data");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spyProcessKillThrough() {
  const originalKill = process.kill.bind(process);
  return vi
    .spyOn(process, "kill")
    .mockImplementation(((pid: number, signal?: string | number) =>
      originalKill(pid, signal)) as typeof process.kill);
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Process ${String(pid)} remained alive after ${String(timeoutMs)}ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  spawnedChildren.splice(0);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")(
  "azLoginDeviceCodeWithOptions real process stream errors",
  () => {
    it("waits for a real spawned az substitute to close after a forced stdout stream error", async () => {
      installFakeAzExecutable();
      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });
      const child = requireSpawnedChild();
      await waitForChildReady(child);
      const childPid = child.pid;
      expect(childPid).toEqual(expect.any(Number));
      const killSpy = spyProcessKillThrough();
      let closeSeen = false;
      let settledBeforeClose = false;
      child.on("close", () => {
        closeSeen = true;
      });
      loginPromise.catch(() => {
        if (!closeSeen) {
          settledBeforeClose = true;
        }
      });

      child.stdout?.destroy(new Error("EPIPE from real child stdout"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      child.stderr?.destroy(new Error("duplicate stderr EPIPE"));

      await expect(loginPromise).rejects.toThrow(
        "az login stdout stream failed: EPIPE from real child stdout",
      );
      expect(closeSeen).toBe(true);
      expect(settledBeforeClose).toBe(false);
      expect(
        killSpy.mock.calls.filter(([pid, signal]) => pid === -childPid! && signal === "SIGTERM"),
      ).toHaveLength(1);
      console.info(
        `[proof] local az substitute pid=${
          child.pid ?? "unknown"
        } forced stdout stream error contained; close observed before rejection`,
      );
    });

    it("escalates when the real spawned az substitute ignores stream-error SIGTERM", async () => {
      installFakeAzExecutable({ ignoreSigterm: true });
      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });
      const child = requireSpawnedChild();
      await waitForChildReady(child);
      const childPid = child.pid;
      expect(childPid).toEqual(expect.any(Number));
      const killSpy = spyProcessKillThrough();
      let closeSeen = false;
      let settledBeforeClose = false;
      child.on("close", () => {
        closeSeen = true;
      });
      loginPromise.catch(() => {
        if (!closeSeen) {
          settledBeforeClose = true;
        }
      });

      child.stdout?.destroy(new Error("EPIPE from stubborn child stdout"));

      await expect(loginPromise).rejects.toThrow(
        "az login stdout stream failed: EPIPE from stubborn child stdout",
      );
      expect(closeSeen).toBe(true);
      expect(settledBeforeClose).toBe(false);
      expect(
        killSpy.mock.calls.filter(([pid, signal]) => pid === -childPid! && signal === "SIGTERM"),
      ).toHaveLength(1);
      expect(
        killSpy.mock.calls.filter(([pid, signal]) => pid === -childPid! && signal === "SIGKILL"),
      ).toHaveLength(1);
      console.info(
        `[proof] local az substitute pid=${
          child.pid ?? "unknown"
        } ignored SIGTERM; SIGKILL escalation closed child before rejection`,
      );
    });
  },
);

describe.skipIf(process.platform !== "win32")(
  "azLoginDeviceCodeWithOptions Windows shell-wrapper stream errors",
  () => {
    it("waits for the shell-launched az descendant to exit before rejection", async () => {
      const pidFile = path.join(makeTempDir("openclaw-foundry-az-pid-"), "pid");
      installFakeAzExecutable({ ignoreSigterm: true, pidFile });
      const loginPromise = azLoginDeviceCodeWithOptions({
        tenantId: "tenant-1",
        allowNoSubscriptions: true,
      });
      const child = requireSpawnedChild();
      await waitForChildReady(child);
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
        throw new Error(
          `Expected a valid fake az descendant pid, received ${String(descendantPid)}`,
        );
      }

      child.stdout?.destroy(new Error("EPIPE from Windows shell wrapper stdout"));

      await expect(loginPromise).rejects.toThrow(
        "az login stdout stream failed: EPIPE from Windows shell wrapper stdout",
      );
      await waitForProcessExit(descendantPid);
      expect(isProcessAlive(descendantPid)).toBe(false);
      console.info(
        `[proof] Windows shell wrapper pid=${
          child.pid ?? "unknown"
        } descendant pid=${descendantPid} exited before stream-error rejection`,
      );
    });
  },
);
