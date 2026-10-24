import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { resolveTestNodeExecPath, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it } from "vitest";
import type { QaSuiteSummaryJson } from "./suite-summary.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./suite-process-lifecycle.test-support.ts", import.meta.url),
);
const artifactsRoot = path.join(repoRoot, ".artifacts", "qa-e2e");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let activeRun: ReturnType<typeof startSuiteProcess> | undefined;
const nodeExecPath = resolveTestNodeExecPath();

function buildSuiteProcessEnv(outputDir: string) {
  const home = path.join(outputDir, "process-home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
    OPENCLAW_QA_SUITE_PROGRESS: "1",
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;
  delete env.OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER;
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.OPENCLAW_NODE_COMPILE_CACHE_WRITER;
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  return env;
}

function forceStopProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    if (!runQaWindowsTaskkill({ pid: child.pid, signal: "SIGKILL" })) {
      child.kill("SIGKILL");
    }
    return;
  }
  const rows = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const owned = new Set([child.pid]);
  // Set iteration also visits newly found children; reverse order kills descendants first.
  for (const parentPid of owned) {
    for (const [pid, parent] of rows) {
      if (parent === parentPid && pid !== undefined && Number.isSafeInteger(pid)) {
        owned.add(pid);
      }
    }
  }
  for (const pid of [...owned].toReversed()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

afterEach(async () => {
  if (activeRun) {
    forceStopProcessTree(activeRun.child);
    await activeRun.closed;
    activeRun = undefined;
  }
});

function startSuiteProcess(outputDir: string, scenarioIds: readonly string[]) {
  const child = spawn(nodeExecPath, ["--import", "tsx", fixturePath, outputDir, ...scenarioIds], {
    cwd: repoRoot,
    env: buildSuiteProcessEnv(outputDir),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const summaryWritten = Promise.withResolvers<void>();
  child.on("message", (message: unknown) => {
    if (message === "summary-written") {
      summaryWritten.resolve();
    }
  });
  const output = { stderr: "" };
  const gatewayPorts = new Set<number>();
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    output.stderr += chunk;
    for (const match of chunk.matchAll(/gateway ready: http:\/\/127\.0\.0\.1:(\d+)/gu)) {
      gatewayPorts.add(Number(match[1]));
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );
  return { child, closed, summaryWritten: summaryWritten.promise, gatewayPorts, output };
}

async function isTcpPortOpen(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

it(
  "qa suite command exits after the terminal summary and leaves no gateway listener",
  { timeout: 495_000 },
  async ({ signal }) => {
    await fs.mkdir(artifactsRoot, { recursive: true });
    const outputDir = tempDirs.make("suite-process-lifecycle-", artifactsRoot);
    const run = (activeRun = startSuiteProcess(outputDir, ["channel-chat-baseline"]));
    const readSummary = async (): Promise<QaSuiteSummaryJson> =>
      JSON.parse(await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"));
    const heartbeat = setInterval(() => {
      process.stderr.write(
        `[qa-process-lifecycle] waiting for completed summary gatewayPorts=${run.gatewayPorts.size}\n`,
      );
    }, 30_000);
    heartbeat.unref();
    const summary = await withinTest(
      Promise.race([
        run.summaryWritten.then(readSummary),
        // IPC and stdio close are separate signals; the durable summary decides
        // when process close arrives before its publication receipt.
        run.closed.then(readSummary),
      ]),
      signal,
    ).finally(() => clearInterval(heartbeat));
    const outcome = await withinTest(run.closed, signal);
    const { output } = run;

    expect(outcome, output.stderr).toEqual({ code: 0, signal: null });
    expect(run.gatewayPorts.size, output.stderr).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      run: { status: "completed" },
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });
    await expect(
      Promise.all([...run.gatewayPorts].map((port) => isTcpPortOpen(port))),
    ).resolves.toEqual([...run.gatewayPorts].map(() => false));
  },
);
