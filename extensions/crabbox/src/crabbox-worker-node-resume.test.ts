import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";

const require = createRequire(import.meta.url);
const home = "/home/worker";
const leaseId = "cbx_resume_process_fixture";
const deviceId = "device-test";
const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
const runtimeDir = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
const packageRoot = path.join(runtimeDir, "node_modules", "openclaw");
const pidFile = path.join(stateDir, "node.pid");
const runtimeLink = path.join(stateDir, "runtime");
const procFiles = ["cmdline", "environ", "cwd"] as const;
type ProcFile = (typeof procFiles)[number];

async function resume(
  options: {
    killError?: string;
    procError?: { file: ProcFile; code: string };
    confirmationError?: string;
  } = {},
) {
  const output: string[] = [];
  let killCalls = 0;
  const kill = vi.fn(() => {
    killCalls += 1;
    const error = killCalls === 1 ? options.killError : options.confirmationError;
    if (error) {
      throw Object.assign(new Error(error), { code: error });
    }
  });
  const processFixture = {
    platform: "linux",
    execPath: "/usr/bin/node",
    env: {},
    umask: vi.fn(),
    kill,
    exitCode: 0,
  };
  const failProcRead = (file: ProcFile) => {
    if (options.procError?.file !== file) {
      return;
    }
    throw Object.assign(new Error(options.procError.code), { code: options.procError.code });
  };
  const fs = {
    existsSync: (file: string) => file === pidFile,
    lstatSync: (file: string) => ({
      isDirectory: () => file === stateDir || file === runtimeDir,
      isSymbolicLink: () => file === runtimeLink,
    }),
    readFileSync: (file: string) => {
      if (file === path.join(packageRoot, "package.json")) {
        return JSON.stringify({ name: "openclaw", version: "2026.11.6" });
      }
      if (file === pidFile) {
        return "123\n";
      }
      if (file === "/proc/123/cmdline") {
        failProcRead("cmdline");
        return "openclaw-node\0";
      }
      if (file === "/proc/123/environ") {
        failProcRead("environ");
        return `OPENCLAW_STATE_DIR=${stateDir}\0`;
      }
      throw new Error(`Unexpected file read: ${file}`);
    },
    realpathSync: (file: string) => {
      if (file === "/proc/123/cwd") {
        failProcRead("cwd");
        return runtimeDir;
      }
      if (file === runtimeLink) {
        return runtimeDir;
      }
      return file;
    },
    openSync: vi.fn(() => 11),
    closeSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 456,
    exitCode: null,
    signalCode: null,
    connected: true,
    unref: vi.fn(),
    send: vi.fn((_message: unknown, callback: () => void) => {
      callback();
      queueMicrotask(() =>
        child.emit("message", { type: "openclaw.node.resume-committed", deviceId }),
      );
    }),
  });
  const spawn = vi.fn(() => {
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("message", { type: "openclaw.node.resume-ready", deviceId });
    });
    return child;
  });
  const script = createCrabboxNodeResumeScript(
    {
      leaseId,
      deviceId,
      nodeBootstrapSha256: "a".repeat(64),
      openclawVersion: "2026.11.6",
      platform: "linux",
      profile: {},
      signal: new AbortController().signal,
      assertCurrent() {},
    },
    "launch",
  )
    .split("CRABBOX_NODE_RESUME_LAUNCH_SCRIPT'\n")[1]!
    .split("\nCRABBOX_NODE_RESUME_LAUNCH_SCRIPT")[0]!;
  await runInNewContext(script, {
    require: (name: string) => {
      if (name === "node:fs") {
        return fs;
      }
      if (name === "node:os") {
        return { homedir: () => home };
      }
      if (name === "node:child_process") {
        return { spawn, spawnSync: vi.fn() };
      }
      return require(name);
    },
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
  });
  return {
    code: processFixture.exitCode,
    output: output.join("\n"),
    launched: spawn.mock.calls.length > 0,
    livenessProbes: killCalls,
  };
}

describe.skipIf(process.platform !== "linux")("Linux cloud worker generated resume script", () => {
  it("treats EPERM from the liveness probe as a live process and reuses verified identity", async () => {
    expect(await resume({ killError: "EPERM" })).toEqual({
      code: 0,
      output: "",
      launched: false,
      livenessProbes: 1,
    });
  });

  it.each(procFiles.flatMap((file) => ["ENOENT", "ESRCH"].map((code) => ({ file, code }))))(
    "replays when the process disappears before the $file read ($code)",
    async ({ file, code }) => {
      expect(await resume({ procError: { file, code }, confirmationError: "ESRCH" })).toEqual({
        code: 0,
        output: "",
        launched: true,
        livenessProbes: 2,
      });
    },
  );

  it.each(
    procFiles.flatMap((file) =>
      ["ENOENT", "ESRCH"].flatMap((code) => [
        { file, code, confirmationError: undefined, confirmation: "success" },
        { file, code, confirmationError: "EPERM", confirmation: "EPERM" },
      ]),
    ),
  )(
    "refuses an ambiguous $file read ($code) when confirmation is $confirmation",
    async ({ file, code, confirmationError }) => {
      const result = await resume({ procError: { file, code }, confirmationError });
      expect(result).toMatchObject({ code: 1, launched: false, livenessProbes: 2 });
      expect(result.output).toContain("release and reprovision the worker");
    },
  );

  it.each(procFiles)("fails closed with recovery guidance for unreadable %s", async (file) => {
    const result = await resume({ procError: { file, code: "EACCES" } });
    expect(result).toMatchObject({ code: 1, launched: false, livenessProbes: 1 });
    expect(result.output).toContain("release and reprovision the worker");
  });
});
