import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const actualSpawn = vi.hoisted((): { value?: typeof import("node:child_process").spawn } => ({}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  actualSpawn.value = actual.spawn;
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import { isProcessAlive, waitForDead } from "./process-wait.test-helper.js";
import {
  resetQaScenarioCommandCleanupTimings,
  runQaScenarioCommandLifecycle,
  setQaScenarioCommandCleanupTimings,
} from "./test-file-scenario-command-lifecycle.js";

type ParentSignal = "SIGINT" | "SIGTERM";
type ParentHandler = (() => void) | ((signal: ParentSignal) => void);

function spyOnProcessKill() {
  return vi.spyOn(process, "kill");
}

function spawnReal(...args: Parameters<NonNullable<typeof actualSpawn.value>>) {
  if (!actualSpawn.value) {
    throw new Error("real spawn unavailable");
  }
  return actualSpawn.value(...args);
}

const sourcePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

function runScript(root: string, script: string, onOutput?: Parameters<typeof runCommand>[1]) {
  return runQaScenarioCommandLifecycle({
    command: process.execPath,
    args: ["-e", script],
    cwd: root,
    env: process.env,
    timeoutMs: 5_000,
    onOutput,
  });
}

function createChild(pid = 42) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  spawnMock.mockReturnValue(child);
  return child;
}

function runCommand(
  timeoutMs?: number,
  onOutput?: (stream: "stderr" | "stdout", chunk: Buffer) => void,
) {
  return runQaScenarioCommandLifecycle({
    command: "/usr/local/bin/scenario-command",
    args: ["--run"],
    cwd: "/tmp/qa",
    env: { OPENCLAW_QA_REF: "test" },
    ...(onOutput ? { onOutput } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe.skipIf(process.platform === "win32")("qa scenario command real POSIX lifecycle", () => {
  afterEach(() => {
    resetQaScenarioCommandCleanupTimings();
    spawnMock.mockReset();
  });

  it("settles within a bound after the leader writes its final result with inherited stdio open", async ({
    onTestFinished,
    signal,
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-settlement-"));
    const ready = Promise.withResolvers<void>();
    let commandChild: ChildProcess | undefined;
    let pending: ReturnType<typeof runQaScenarioCommandLifecycle> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        if (signal.aborted && commandChild?.exitCode === null && commandChild.signalCode === null) {
          // The held child owns this identity; its exit starts the product's graceful group cleanup.
          commandChild.kill("SIGTERM");
        }
        await pending?.catch(() => undefined);
        await rm(root, { force: true, recursive: true });
      })();
      return cleanupPromise;
    };
    // Vitest abandons timed-out bodies; its hook must join the same finally cleanup.
    onTestFinished(cleanup);
    let stdout = "";
    spawnMock.mockImplementation((...args: Parameters<NonNullable<typeof actualSpawn.value>>) => {
      commandChild = spawnReal(...args);
      return commandChild;
    });
    setQaScenarioCommandCleanupTimings({ killGraceMs: 100, forceSettleMs: 100 });
    try {
      const descendantScript = [
        "process.on('SIGTERM', () => {});",
        // Disconnect follows the leader's flushed write and exit, regardless of scheduling.
        "process.once('disconnect', () => process.stdout.write('delayed descendant output\\n'));",
        "process.send('ready');",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });`,
        "child.once('message', () => process.stdout.write('Docker scheduling finished\\n', () => process.exit(7)));",
        "child.unref();",
      ].join("\n");

      pending = runScript(root, leaderScript, (stream, chunk) => {
        if (stream === "stdout") {
          stdout += chunk.toString();
          if (stdout.includes("Docker scheduling finished\n")) {
            ready.resolve();
          }
        }
      });
      await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          pending,
          "command settled while waiting for descendant readiness",
        ),
        signal,
      );
      const startedAt = Date.now();
      const result = await withinTest(
        pending,
        AbortSignal.any([signal, AbortSignal.timeout(1_500)]),
      );

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      // The exact result proves cleanup succeeded. A later numeric PID probe can
      // race PID reuse and inspect an unrelated process.
      expect(result).toEqual({
        exitCode: 7,
        signal: null,
        stdout: "Docker scheduling finished\ndelayed descendant output\n",
        stderr: "",
      });
    } finally {
      await cleanup();
    }
  });

  it("reports that a self-detached descendant escaped and cleans it explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-setsid-escape-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;
    spawnMock.mockImplementation(spawnReal);
    try {
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.stdout.write('escaped descendant output\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();`,
        "process.exit(0);",
      ].join("\n");

      const result = await runScript(root, leaderScript);

      // The fixture writes its PID before stdout, which the settled result retains.
      descendantPid = Number.parseInt(await readFile(descendantPidPath, "utf8"), 10);
      expect(result).toMatchObject({ exitCode: 1, failureMessage: "stdio-drain-timeout" });
      expect(result.stdout).toContain("escaped descendant output");
      expect(isProcessAlive(descendantPid)).toBe(true);
    } finally {
      // A true setsid descendant is outside the original PGID by design.
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
        await waitForDead(descendantPid).catch(() => undefined);
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans the command group before re-raising a parent SIGTERM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-parent-signal-"));
    const bundlePath = path.join(root, "test-file-scenario-command-lifecycle.mjs");
    // Compile before the readiness window; a cold tsx child can exceed it under the full QA suite.
    // Keep the real SDK helper implementations without unrelated barrel startup or SQL assets.
    await esbuild({
      alias: {
        "openclaw/plugin-sdk/process-runtime": sourcePath("../../../src/shared/pid-alive.ts"),
        "openclaw/plugin-sdk/text-utility-runtime": sourcePath(
          "../../../packages/normalization-core/src/utf16-slice.ts",
        ),
      },
      bundle: true,
      entryPoints: [sourcePath("./test-file-scenario-command-lifecycle.ts")],
      format: "esm",
      outfile: bundlePath,
      platform: "node",
      target: "node22",
      // The plugin package tsconfig targets built SDK declarations; this fixture runs from source.
      tsconfig: sourcePath("../../../tsconfig.json"),
    });
    const moduleUrl = pathToFileURL(bundlePath).href;
    let descendant: Socket | undefined;
    const server = createServer((socket) => {
      descendant = socket;
      socket.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("descendant observer did not bind a TCP port");
    }
    const connected = once(server, "connection", { signal: AbortSignal.timeout(10_000) });
    const controllerScript = [
      `import { runQaScenarioCommandLifecycle, setQaScenarioCommandCleanupTimings } from ${JSON.stringify(moduleUrl)};`,
      "setQaScenarioCommandCleanupTimings({ killGraceMs: 50, forceSettleMs: 50 });",
      "const nested = [",
      "  \"process.on('SIGTERM', () => {});\",",
      `  ${JSON.stringify(`const socket = require('node:net').connect(${address.port}, '127.0.0.1');`)},`,
      "  \"socket.on('error', () => process.exit(1));\",",
      "  \"socket.on('close', () => process.exit(0));\",",
      "].join(' ');",
      "await runQaScenarioCommandLifecycle({",
      "  command: process.execPath,",
      "  args: ['-e', nested],",
      `  cwd: ${JSON.stringify(root)},`,
      "  env: process.env,",
      "  timeoutMs: 5000,",
      "});",
    ].join("\n");
    const controller = spawnReal(
      process.execPath,
      ["--input-type=module", "-e", controllerScript],
      { cwd: process.cwd(), env: process.env, stdio: "ignore" },
    );
    try {
      await connected;
      if (!descendant) {
        throw new Error("descendant did not connect");
      }
      // The held socket identifies this process even after its numeric PID is reused.
      const descendantClosed = once(descendant, "close", {
        signal: AbortSignal.timeout(10_000),
      });
      const controllerClosed = once(controller, "close");
      controller.kill("SIGTERM");
      const [[exitCode, signal]] = await Promise.all([controllerClosed, descendantClosed]);

      expect([exitCode, signal]).toEqual([null, "SIGTERM"]);
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.kill("SIGKILL");
      }
      descendant?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("qa scenario command lifecycle", () => {
  const parentHandlers = new Map<ParentSignal | "exit", ParentHandler>();
  const timeoutResult = {
    exitCode: 1,
    failureMessage: "scenario-command timed out after 100ms",
    signal: null,
  };
  let processKill: ReturnType<typeof spyOnProcessKill>;

  function keepProcessGroupAliveUntilKill() {
    let alive = true;
    processKill.mockImplementation((pid, signal) => {
      if (pid === -42 && signal === "SIGKILL") {
        alive = false;
      }
      if (pid === -42 && signal === 0 && !alive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    for (const method of ["once", "on"] as const) {
      vi.spyOn(process, method).mockImplementation((event, listener) => {
        parentHandlers.set(event as ParentSignal | "exit", listener as ParentHandler);
        return process;
      });
    }
    vi.spyOn(process, "removeListener").mockImplementation((event, listener) => {
      if (parentHandlers.get(event as ParentSignal | "exit") === listener) {
        parentHandlers.delete(event as ParentSignal | "exit");
      }
      return process;
    });
    processKill = spyOnProcessKill().mockImplementation((pid, signal) => {
      if (pid === -42 && signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
  });

  afterEach(() => {
    resetQaScenarioCommandCleanupTimings();
    parentHandlers.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves the exact close result and removes parent handlers", async () => {
    const child = createChild();
    const output = vi.fn();
    const resultPromise = runCommand(5_000, output);

    child.stdout?.emit("data", Buffer.from("out\n"));
    child.stderr?.emit("data", Buffer.from("err\n"));
    child.emit("exit", 3, null);
    child.emit("close", 3, null);

    expect(output.mock.calls).toEqual([
      ["stdout", Buffer.from("out\n")],
      ["stderr", Buffer.from("err\n")],
    ]);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(spawnMock).toHaveBeenCalledWith("/usr/local/bin/scenario-command", ["--run"], {
      cwd: "/tmp/qa",
      detached: true,
      env: { OPENCLAW_QA_REF: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(parentHandlers.size).toBe(0);
    expect(processKill).toHaveBeenCalledWith(-42, 0);
    processKill.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("preserves the Windows taskkill timeout lifecycle", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    spawnSyncMock.mockReturnValue({ status: 0 });
    createChild(12345);
    try {
      const resultPromise = runCommand(100);
      await vi.advanceTimersByTimeAsync(130);

      await expect(resultPromise).resolves.toMatchObject(timeoutResult);
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
        ["/PID", "12345", "/T"],
        ["/PID", "12345", "/T", "/F"],
      ]);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });

  it("escalates timed-out commands and preserves the timeout result", async () => {
    const child = createChild();
    keepProcessGroupAliveUntilKill();

    const resultPromise = runCommand(100);
    await vi.advanceTimersByTimeAsync(120);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual({
      ...timeoutResult,
      stdout: "",
      stderr: "",
    });
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-42, "SIGKILL");
    expect(parentHandlers.size).toBe(0);
  });

  it.each([
    {
      phase: "running",
      result: {
        exitCode: 1,
        failureMessage: "scenario-command interrupted by SIGTERM",
        signal: "SIGTERM",
      },
    },
    { phase: "exited", result: { exitCode: 7, signal: null } },
    { phase: "timed out", result: timeoutResult },
  ])(
    "re-raises a parent signal when the command is $phase without changing its outcome",
    async ({ phase, result }) => {
      const child = createChild();
      keepProcessGroupAliveUntilKill();

      const resultPromise = runCommand(100);
      if (phase === "exited") {
        child.emit("exit", 7, null);
      } else if (phase === "timed out") {
        await vi.advanceTimersByTimeAsync(100);
      }
      const signalHandler = parentHandlers.get("SIGTERM") as
        | ((signal: ParentSignal) => void)
        | undefined;
      expect(signalHandler).toBeDefined();
      signalHandler?.("SIGTERM");
      await vi.advanceTimersByTimeAsync(20);
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(10);

      await expect(resultPromise).resolves.toEqual({
        ...result,
        stdout: "",
        stderr: "",
      });
      expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(parentHandlers.size).toBe(0);
    },
  );
});
