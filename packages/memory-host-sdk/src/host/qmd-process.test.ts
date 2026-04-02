import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  runCliCommand,
} from "./qmd-process.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
  return child;
}

type HungMockChild = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createHungChild(pid = 4321): HungMockChild {
  const child = new EventEmitter() as HungMockChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

let tempDir = "";
let platformSpy: { mockRestore(): void } | null = null;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-win-spawn-"));
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterEach(async () => {
  platformSpy?.mockRestore();
  process.env.PATH = originalPath;
  process.env.PATHEXT = originalPathExt;
  spawnMock.mockReset();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("runCliCommand timeout cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("kills the process group on POSIX timeout", async () => {
    vi.useFakeTimers();
    platformSpy?.mockRestore();
    const posixPlatformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const processKillMock = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = createHungChild(4321);
    spawnMock.mockReturnValue(child);

    const promise = runCliCommand({
      commandSummary: "qmd search",
      spawnInvocation: { command: "qmd", argv: ["search", "hello"] },
      env: process.env,
      cwd: "/tmp",
      timeoutMs: 25,
      maxOutputChars: 1000,
    });
    const rejection = expect(promise).rejects.toThrow("qmd search timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(processKillMock).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    posixPlatformSpy.mockRestore();
  });

  it("falls back to child.kill on Windows timeout", async () => {
    vi.useFakeTimers();
    const processKillMock = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = createHungChild(9876);
    spawnMock.mockReturnValue(child);

    const promise = runCliCommand({
      commandSummary: "qmd search",
      spawnInvocation: { command: "qmd", argv: ["search", "hello"] },
      env: process.env,
      cwd: "/tmp",
      timeoutMs: 25,
      maxOutputChars: 1000,
    });
    const rejection = expect(promise).rejects.toThrow("qmd search timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(processKillMock).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("resolveCliSpawnInvocation", () => {
  it("unwraps npm cmd shims to a direct node entrypoint", async () => {
    const binDir = path.join(tempDir, "node_modules", ".bin");
    const packageDir = path.join(tempDir, "node_modules", "qmd");
    const scriptPath = path.join(packageDir, "dist", "cli.js");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argv).toEqual([scriptPath, "query", "hello"]);
    expect(invocation.shell).not.toBe(true);
    expect(invocation.windowsHide).toBe(true);
  });

  it("fails closed when a Windows cmd shim cannot be resolved without shell execution", async () => {
    const binDir = path.join(tempDir, "bad-bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\nREM no entrypoint\r\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(() =>
      resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query", "hello"],
        env: process.env,
        packageName: "qmd",
      }),
    ).toThrow(/without shell execution/);
  });

  it("keeps bare commands bare when no Windows wrapper exists on PATH", () => {
    process.env.PATH = originalPath ?? "";
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe("qmd");
    expect(invocation.argv).toEqual(["query", "hello"]);
    expect(invocation.shell).not.toBe(true);
  });
});

describe("checkQmdBinaryAvailability", () => {
  it("returns available when the qmd process spawns successfully", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: true });
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns unavailable when the qmd process cannot be spawned", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
  });

  it("does not treat close-before-spawn as a successful availability probe", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close"));
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, error: "spawn qmd ENOENT" });
  });
});
