// Real process coverage for extension exec tree cleanup.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand, type ExecResult } from "./exec.js";

const DEFAULT_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;

const cleanupPids = new Set<number>();

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !isProcessAlive(pid);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`timed out waiting for ${path}`);
}

function readReadyPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid descendant pid: ${pid}`);
  }
  return pid;
}

type Trigger = "abort" | "output-limit" | "timeout";

async function runProcessTreeProof(
  trigger: Trigger,
  options: { ignoreDescendantSigterm?: boolean } = {},
): Promise<{ descendantPid: number; result: ExecResult }> {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-exec-tree-"));
  const readyPath = join(dir, "ready");
  const triggerPath = join(dir, "trigger");
  const childScript = `
const fs = require("node:fs");
${options.ignoreDescendantSigterm ? "process.on('SIGTERM', () => {});" : ""}
fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
setInterval(() => {}, 1000);
`;
  const outputFlood =
    trigger === "output-limit"
      ? `process.stdout.write("x".repeat(${DEFAULT_OUTPUT_LIMIT_CHARS + 1}));`
      : "";
  const parentScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
  detached: false,
  stdio: ["ignore", "ignore", "ignore"],
});
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(readyPath)})) {
  if (Date.now() > deadline) {
    throw new Error("descendant did not become ready");
  }
}
console.log("descendant_pid=" + child.pid);
if (${trigger === "output-limit" ? "true" : "false"}) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(${JSON.stringify(triggerPath)})) {
    if (Date.now() > deadline) {
      throw new Error("output trigger did not arrive");
    }
  }
  ${outputFlood}
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

  const controller = new AbortController();
  const resultPromise = execCommand(process.execPath, ["-e", parentScript], process.cwd(), {
    signal: controller.signal,
    // The timeout clock starts with execCommand. Keep it long enough for the
    // descendant PID handshake so cleanup failures stay tracked by afterEach.
    timeout: trigger === "timeout" ? 2000 : undefined,
  });
  try {
    await waitForFile(readyPath, 5000);
    const descendantPid = readReadyPid(readyPath);
    cleanupPids.add(descendantPid);
    if (trigger === "abort") {
      controller.abort();
    } else if (trigger === "output-limit") {
      writeFileSync(triggerPath, "go");
    }
    const result = await resultPromise;
    return { descendantPid, result };
  } catch (error) {
    controller.abort();
    await resultPromise.catch(() => undefined);
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("execCommand real process-tree cleanup", () => {
  afterEach(() => {
    for (const pid of cleanupPids) {
      forceKillPid(pid);
    }
    cleanupPids.clear();
  });

  it("waits until timeout cleanup removes a SIGTERM-resistant descendant", async () => {
    const { descendantPid, result } = await runProcessTreeProof("timeout", {
      ignoreDescendantSigterm: true,
    });

    expect(result.killed).toBe(true);
    expect(result.outputLimitExceeded).toBeUndefined();
    expect(await waitForGone(descendantPid, 250)).toBe(true);
  }, 15_000);

  it("removes a wrapper descendant after abort", async () => {
    const { descendantPid, result } = await runProcessTreeProof("abort");

    expect(result.killed).toBe(true);
    expect(await waitForGone(descendantPid, 250)).toBe(true);
  });

  it("removes a wrapper descendant after default output overflow", async () => {
    const { descendantPid, result } = await runProcessTreeProof("output-limit");

    expect(result).toMatchObject({
      killed: true,
      code: 1,
      outputLimitExceeded: "stdout",
    });
    expect(await waitForGone(descendantPid, 250)).toBe(true);
  }, 10_000);
});
