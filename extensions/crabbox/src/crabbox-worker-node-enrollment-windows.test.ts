import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const home = String.raw`C:\Users\Administrator`;
const programFiles = String.raw`C:\Program Files`;
const node = path.win32.join(programFiles, "nodejs", "node.exe");
const leaseId = "cbx_windows_replay_fixture";
const stateDir = path.win32.join(home, ".openclaw", "cloud-workers", leaseId);
const runtimeDir = path.win32.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
const cli = path.win32.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
const launcher = path.win32.join(
  programFiles,
  "Crabbox",
  "bin",
  "Start-CrabboxDetachedProcess.ps1",
);
const startTime = "2026-09-09T12:00:00.1234567Z";
const replayError =
  "Cloud worker node is running a different bootstrap artifact or invocation; release and reprovision the worker";

type ReplayOptions = {
  interrupted?: "dangling-runtime" | "receipt-only";
  desktop?: boolean;
  currentSession?: { sessionId: number; userSid: string };
  processEntry?: Record<string, unknown>;
  processOutput?: string;
  launchRecord?: Record<string, unknown>;
  recordOutput?: string;
  missingLauncher?: boolean;
  probeFailure?: boolean;
  canonicalizePaths?: boolean;
};

async function replay(options: ReplayOptions = {}) {
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    desktop: options.desktop,
    target: "windows/normal",
    enrollment: {
      mode: "connect",
      setupCode: "synthetic-windows-code",
      setupId: "synthetic-windows-setup",
      openclawVersion: "2026.8.1",
      nodeBootstrap: createNodeBootstrapFixture(),
      displayName: "Windows replay fixture",
      waitForDeviceId: async () => "synthetic-device",
    },
  });
  const output: string[] = [];
  const processFixture = {
    platform: "win32",
    execPath: node,
    env: { ...setup.forwardedEnv, ProgramFiles: programFiles, PATH: path.win32.dirname(node) },
    umask: vi.fn(),
    kill: vi.fn(),
    exitCode: 0,
  };
  const fs = {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    mkdtempSync: () => path.win32.join(home, "desktop-probe"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    symlinkSync: vi.fn(),
    rmSync: vi.fn(),
    existsSync: (file: string) =>
      (file === path.win32.join(stateDir, "node.pid") && !options.interrupted) ||
      file === runtimeDir ||
      (file === launcher && !options.missingLauncher),
    lstatSync: (file: string) => {
      if (file === runtimeDir) {
        return { isDirectory: () => true };
      }
      if (
        (file === path.win32.join(stateDir, "runtime") &&
          options.interrupted &&
          options.interrupted !== "receipt-only") ||
        (file === path.win32.join(stateDir, "node-launch.json") &&
          options.interrupted === "receipt-only")
      ) {
        return { isSymbolicLink: () => file === path.win32.join(stateDir, "runtime") };
      }
      throw Object.assign(new Error("Missing runtime pointer"), { code: "ENOENT" });
    },
    readFileSync: (file: string) => {
      if (file === path.win32.join(runtimeDir, "node_modules", "openclaw", "package.json")) {
        return JSON.stringify({ name: "openclaw", version: "2026.8.1" });
      }
      if (file === path.win32.join(stateDir, "node.pid")) {
        return "123\n";
      }
      if (file === path.win32.join(stateDir, "node-launch.json")) {
        return (
          options.recordOutput ??
          JSON.stringify({
            pid: 123,
            startTime,
            runtimeDir,
            stateDir,
            cli,
            ...(options.desktop ? { sessionId: 2, userSid: "S-1-5-21-1001" } : {}),
            ...options.launchRecord,
          })
        );
      }
      throw new Error(`Unexpected file read: ${file}`);
    },
    realpathSync: (file: string) => {
      if (options.canonicalizePaths && file.toLowerCase() === node.toLowerCase()) {
        return node;
      }
      if (options.canonicalizePaths && file.toLowerCase() === home.toLowerCase()) {
        return home;
      }
      return file;
    },
  };
  const spawn = vi.fn(() => {
    throw new Error("Replay must not launch another node");
  });
  const spawnSync = vi.fn((binary: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    if (binary === node && args[0] === cli) {
      return { status: 0, stdout: args[1] === "--version" ? "OpenClaw 2026.8.1" : "" };
    }
    if (options.desktop && args.includes("-File")) {
      expect(processFixture.env).not.toHaveProperty("CRABBOX_WORKER_BOOTSTRAP_TOKEN");
      expect(processFixture.env).not.toHaveProperty("CRABBOX_WORKER_SETUP_CODE");
      return {
        status: 0,
        stdout: JSON.stringify(
          options.currentSession ?? { sessionId: 2, userSid: "S-1-5-21-1001" },
        ),
      };
    }
    expect(binary).toBe("powershell.exe");
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args.at(-1)).toContain("Get-CimInstance Win32_Process");
    expect(args.at(-1)).toContain("ProcessId=123");
    expect(opts.env).not.toHaveProperty("CRABBOX_WORKER_BOOTSTRAP_TOKEN");
    expect(opts.env).not.toHaveProperty("CRABBOX_WORKER_SETUP_CODE");
    expect(opts.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    return {
      status: options.probeFailure ? 1 : 0,
      stdout:
        options.processOutput ??
        JSON.stringify({
          pid: 123,
          startTime,
          executablePath: node,
          commandLine: `"${node}" "${cli}" connect --ephemeral`,
          ...(options.desktop ? { sessionId: 2, userSid: "S-1-5-21-1001" } : {}),
          ...options.processEntry,
        }),
    };
  });
  const encoded = setup.command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)?.[1];
  expect(encoded).toBeDefined();
  const script = Buffer.from(encoded!, "base64").toString("utf8");
  await runInNewContext(script, {
    Buffer,
    require: (name: string) => {
      if (name === "node:fs") {
        return fs;
      }
      if (name === "node:path") {
        return path.win32;
      }
      if (name === "node:os") {
        return {
          homedir: () => (options.canonicalizePaths ? home.toLowerCase() : home),
          tmpdir: () => path.win32.join(home, "Temp"),
        };
      }
      if (name === "node:child_process") {
        return { spawn, spawnSync };
      }
      return require(name);
    },
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(fs.chmodSync).not.toHaveBeenCalled();
  expect(processFixture.umask).not.toHaveBeenCalled();
  if (options.interrupted) {
    expect(spawnSync.mock.calls.filter(([, args]) => args.includes("-File"))).toEqual([]);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.symlinkSync).not.toHaveBeenCalled();
    expect(processFixture.kill).not.toHaveBeenCalled();
  }
  return { code: processFixture.exitCode, output: output.join("\n"), spawnSync, fs };
}

describe("native Windows node enrollment replay", () => {
  it("reuses canonical drive-letter paths without launching a second process", async () => {
    const result = await replay({
      canonicalizePaths: true,
      processEntry: { executablePath: node.toLowerCase() },
    });
    expect(result).toMatchObject({
      code: 0,
      output:
        "CRABBOX_PHASE:openclaw-bootstrap-preparation\nCRABBOX_PHASE:openclaw-bootstrap-complete",
    });
    expect(result.spawnSync).toHaveBeenCalledOnce();
    expect(result.fs.mkdirSync).toHaveBeenCalledWith(stateDir, { recursive: true });
  });

  it.each<[string, ReplayOptions]>([
    ["malformed launch record", { recordOutput: "invalid JSON" }],
    ["record PID mismatch", { launchRecord: { pid: 124 } }],
    ["reused PID creation time", { processEntry: { startTime: startTime + "-other" } }],
    ["record runtime directory mismatch", { launchRecord: { runtimeDir: home } }],
    ["record state directory mismatch", { launchRecord: { stateDir: home } }],
    ["record CLI mismatch", { launchRecord: { cli: node } }],
    ["actual node PID mismatch", { processEntry: { pid: 124 } }],
    ["missing creation time", { processEntry: { startTime: "" } }],
    ["wrong executable", { processEntry: { executablePath: launcher } }],
    ["missing executable", { processEntry: { executablePath: null } }],
    ["title without invocation", { processEntry: { commandLine: "openclaw-connect" } }],
    [
      "CLI path in a later argument",
      { processEntry: { commandLine: `"${node}" other-script.cjs "${cli}"` } },
    ],
    ["unavailable CIM probe", { probeFailure: true }],
    ["malformed CIM probe", { processOutput: "invalid JSON" }],
    ["ambiguous CIM processes", { processOutput: '[{"pid":123},{"pid":124}]' }],
  ])("fails closed for %s", async (_name, options) => {
    expect(await replay(options)).toMatchObject({
      code: 1,
      output: expect.stringContaining(replayError),
    });
  });

  it("fails before process probes or state writes when the managed launcher is absent", async () => {
    const result = await replay({ missingLauncher: true });
    expect(result).toMatchObject({
      code: 1,
      output: expect.stringContaining(`Cloud worker requires ${launcher}`),
    });
    expect(result.spawnSync).not.toHaveBeenCalled();
    expect(result.fs.mkdirSync).not.toHaveBeenCalled();
  });
});

describe("native Windows desktop enrollment replay", () => {
  it.each(["dangling-runtime", "receipt-only"] as const)(
    "preserves an interrupted launch instead of issuing another service request: %s",
    async (interrupted) => {
      expect(await replay({ desktop: true, interrupted })).toMatchObject({
        code: 1,
        output: expect.stringContaining("launch is incomplete"),
      });
    },
  );
  it("reuses only the node in the current interactive account and session", async () => {
    expect(await replay({ desktop: true, missingLauncher: true })).toMatchObject({ code: 0 });
  });

  it.each([
    { name: "Session 0 node", processEntry: { sessionId: 0 } },
    { name: "a different process session", processEntry: { sessionId: 3 } },
    { name: "a different process account", processEntry: { userSid: "S-1-5-21-2001" } },
    { name: "stale recorded session", launchRecord: { sessionId: 3 } },
    { name: "stale recorded account", launchRecord: { userSid: "S-1-5-21-2001" } },
    { name: "changed active session", currentSession: { sessionId: 3, userSid: "S-1-5-21-1001" } },
    {
      name: "failed active-session lookup",
      currentSession: { sessionId: 0, userSid: "S-1-5-21-1001" },
    },
  ])("rejects $name", async ({ name: _name, ...options }) => {
    expect(await replay({ desktop: true, ...options })).toMatchObject({
      code: 1,
      output: expect.stringContaining(replayError),
    });
  });
});
