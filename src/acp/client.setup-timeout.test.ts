/** Real-process regression tests for bounded ACP client session setup. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { runAcpClientInteractive } from "./client.js";

const SETUP_TIMEOUT_MS = 500;
const FIXTURE_SELF_CLEANUP_MS = 2_000;

const tempDirs = createTrackedTempDirs();
const trackedPids = new Set<number>();

function isProcessAlive(pid: number): boolean {
  try {
    // Node defines signal 0 as a cross-platform existence probe, including on Windows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  expect(isProcessAlive(pid)).toBe(false);
}

async function createHungAcpServer(
  phase: "initialization" | "session creation",
): Promise<{ cwd: string; pidFile: string }> {
  const cwd = await tempDirs.make("openclaw-acp-client-setup-timeout-");
  const pidFile = path.join(cwd, "pids.json");
  const script = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(
  path.join(process.cwd(), "pids.json"),
  JSON.stringify({ serverPid: process.pid, descendantPid: descendant.pid }),
);

if (${JSON.stringify(phase)} === "session creation") {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: 1 },
        }) + "\\n",
      );
    }
  });
} else {
  process.stdin.resume();
}

setTimeout(() => {
  try {
    descendant.kill("SIGKILL");
  } catch {}
  process.exit(23);
}, ${String(FIXTURE_SELF_CLEANUP_MS)});
`;
  await writeFile(path.join(cwd, "acp"), script, "utf8");
  return { cwd, pidFile };
}

async function expectBoundedSetupFailure(phase: "initialization" | "session creation") {
  const fixture = await createHungAcpServer(phase);
  const startedAt = Date.now();
  let error: unknown;
  try {
    // The ACP client prepends "acp" to custom server args, so Node executes cwd/acp.
    await runAcpClientInteractive({
      cwd: fixture.cwd,
      serverCommand: process.execPath,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
    });
  } catch (caught) {
    error = caught;
  }

  const pids = JSON.parse(await readFile(fixture.pidFile, "utf8")) as {
    serverPid: number;
    descendantPid: number;
  };
  trackedPids.add(pids.serverPid);
  trackedPids.add(pids.descendantPid);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    `ACP client setup timed out during ${phase} after ${String(SETUP_TIMEOUT_MS)}ms`,
  );
  expect(Date.now() - startedAt).toBeLessThan(FIXTURE_SELF_CLEANUP_MS);
  // POSIX owns a detached process group; Windows uses the canonical taskkill /T path.
  await waitForProcessExit(pids.serverPid);
  await waitForProcessExit(pids.descendantPid);
}

afterEach(async () => {
  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }
  trackedPids.clear();
  await tempDirs.cleanup();
});

describe("ACP client setup deadline", () => {
  it("bounds an initialize request when the ACP server never responds", async () => {
    await expectBoundedSetupFailure("initialization");
  });

  it("shares the deadline with session creation and cleans up the server tree", async () => {
    await expectBoundedSetupFailure("session creation");
  });
});
