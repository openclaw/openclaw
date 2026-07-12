import { spawn } from "node:child_process";
// ACPX real-process tests cover lease cleanup after session detachment.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_ACPX_LEASE_ID_ENV, OPENCLAW_GATEWAY_INSTANCE_ID_ENV } from "./process-lease.js";
import { cleanupOpenClawOwnedAcpxProcessTree } from "./process-reaper.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("ACPX lease process reaping", () => {
  const cleanupDirs = new Set<string>();
  const cleanupPids = new Set<number>();

  afterEach(async () => {
    for (const pid of cleanupPids) {
      if (!isProcessAlive(pid)) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    cleanupPids.clear();
    await Promise.all(
      Array.from(cleanupDirs, async (directory) => {
        await fs.rm(directory, { force: true, recursive: true });
      }),
    );
    cleanupDirs.clear();
  });

  it("reaps a reparented detached descendant by inherited lease identity", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-lease-test-"));
    cleanupDirs.add(tempDir);
    const pidFile = path.join(tempDir, "child.pid");
    const leaseId = `lease-${process.pid}-${Date.now()}`;
    const gatewayInstanceId = `gateway-${process.pid}-${Date.now()}`;
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
          "  detached: true,",
          '  stdio: "ignore",',
          "  env: process.env,",
          "});",
          "child.unref();",
          "fs.writeFileSync(process.argv[1], String(child.pid));",
        ].join(" "),
        pidFile,
      ],
      {
        env: {
          ...process.env,
          [OPENCLAW_ACPX_LEASE_ID_ENV]: leaseId,
          [OPENCLAW_GATEWAY_INSTANCE_ID_ENV]: gatewayInstanceId,
        },
        stdio: "ignore",
      },
    );
    const launcherPid = launcher.pid;
    if (!launcherPid) {
      throw new Error("launcher pid unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      launcher.once("error", reject);
      launcher.once("exit", () => resolve());
    });

    await vi.waitFor(
      async () => {
        const value = await fs.readFile(pidFile, "utf8");
        expect(value.trim()).toMatch(/^\d+$/);
      },
      { timeout: 5_000 },
    );
    const childPid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    cleanupPids.add(childPid);
    expect(isProcessAlive(childPid)).toBe(true);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: launcherPid,
      rootCommand: "node /tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs",
      expectedLeaseId: leaseId,
      expectedGatewayInstanceId: gatewayInstanceId,
      wrapperRoot: "/tmp/openclaw/acpx",
    });

    expect(result.inspectedPids).toContain(childPid);
    expect(result.terminatedPids).toContain(childPid);
    expect(result.survivingPids ?? []).toStrictEqual([]);
    await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), { timeout: 5_000 });
    cleanupPids.delete(childPid);
    await fs.rm(tempDir, { recursive: true, force: true });
    cleanupDirs.delete(tempDir);
  }, 15_000);
});
