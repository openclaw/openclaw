import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { resolveTestNodeExecPath, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { QaSuiteSummaryJson } from "./suite-summary.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./suite-process-lifecycle.test-support.ts", import.meta.url),
);
const artifactsRoot = path.join(repoRoot, ".artifacts", "qa-e2e");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcess>();
const nodeExecPath = resolveTestNodeExecPath();

const PROCESS_LIFECYCLE_SCENARIO = "channel-chat-baseline";
// Keep the enclosing test budget; readiness and teardown use owned process signals.
const SUITE_COMPLETION_TIMEOUT_MS = 420_000;
const POST_SUMMARY_EXIT_TIMEOUT_MS = 45_000;

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
    .flatMap((line) => {
      const [pidText, parentPidText] = line.trim().split(/\s+/u);
      const pid = Number(pidText);
      const parentPid = Number(parentPidText);
      return Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)
        ? [{ pid, parentPid }]
        : [];
    });
  const owned = new Set([child.pid]);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const { pid, parentPid } of rows) {
      if (owned.has(parentPid) && !owned.has(pid)) {
        owned.add(pid);
        foundDescendant = true;
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
  for (const child of activeChildren) {
    forceStopProcessTree(child);
  }
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
        }),
    ),
  );
  activeChildren.clear();
});

function startSuiteProcess(outputDir: string, scenarioIds: readonly string[]) {
  const child = spawn(nodeExecPath, ["--import", "tsx", fixturePath, outputDir, ...scenarioIds], {
    cwd: repoRoot,
    env: buildSuiteProcessEnv(outputDir),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  activeChildren.add(child);
  const summaryWritten = Promise.withResolvers<void>();
  child.on("message", (message: unknown) => {
    if (message === "summary-written") {
      summaryWritten.resolve();
    }
  });
  let stdout = "";
  let stderr = "";
  const gatewayPorts = new Set<number>();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    for (const match of chunk.matchAll(/gateway ready: http:\/\/127\.0\.0\.1:(\d+)/gu)) {
      gatewayPorts.add(Number(match[1]));
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        activeChildren.delete(child);
        resolve({ code, signal });
      });
    },
  );
  return {
    child,
    closed,
    summaryWritten: summaryWritten.promise,
    gatewayPorts,
    output: () => ({ stderr, stdout }),
  };
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

async function readCompletedSummary(outputDir: string) {
  const summary = JSON.parse(
    await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
  ) as QaSuiteSummaryJson;
  if (summary.run.status !== "completed") {
    throw new Error(`QA suite summary is missing lifecycle status: ${summary.run.status}`);
  }
  return summary;
}

describe("qa suite command process lifecycle", () => {
  it(
    "exits after the terminal summary and leaves no gateway listener",
    { timeout: SUITE_COMPLETION_TIMEOUT_MS + POST_SUMMARY_EXIT_TIMEOUT_MS + 30_000 },
    async ({ signal }) => {
      await fs.mkdir(artifactsRoot, { recursive: true });
      const outputDir = tempDirs.make("suite-process-lifecycle-", artifactsRoot);
      const run = startSuiteProcess(outputDir, [PROCESS_LIFECYCLE_SCENARIO]);
      const startedWaitingAt = Date.now();
      const heartbeat = setInterval(() => {
        const output = run.output();
        process.stderr.write(
          `[qa-process-lifecycle] waiting for completed summary elapsedMs=${Date.now() - startedWaitingAt} gatewayPorts=${run.gatewayPorts.size} stderrBytes=${Buffer.byteLength(output.stderr)}\n`,
        );
      }, 30_000);
      heartbeat.unref();
      const summary = await withinTest(
        Promise.race([
          run.summaryWritten.then(() => readCompletedSummary(outputDir)),
          // IPC and stdio close are separate signals; the durable summary decides
          // when process close arrives before its publication receipt.
          run.closed.then(async (outcome) => {
            try {
              return await readCompletedSummary(outputDir);
            } catch (cause) {
              const output = run.output();
              throw new Error(
                `QA suite process exited before writing a completed summary: ${JSON.stringify(outcome)}\nstdout:\n${output.stdout.slice(-8_000)}\nstderr:\n${output.stderr.slice(-8_000)}`,
                { cause },
              );
            }
          }),
        ]),
        signal,
      ).finally(() => clearInterval(heartbeat));
      const outcome = await withinTest(run.closed, signal);
      const output = run.output();

      expect(outcome, output.stderr).toEqual({ code: 0, signal: null });
      expect(run.gatewayPorts.size, output.stderr).toBeGreaterThan(0);
      expect(summary.run.status).toBe("completed");
      expect(summary.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
      await expect(
        Promise.all([...run.gatewayPorts].map((port) => isTcpPortOpen(port))),
      ).resolves.toEqual([...run.gatewayPorts].map(() => false));
    },
  );
});
