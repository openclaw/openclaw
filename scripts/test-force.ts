#!/usr/bin/env tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { forceFreePort, type PortProcess } from "../src/cli/ports.js";

const DEFAULT_PORT = 18789;
const DEFAULT_LOCK = path.join(os.tmpdir(), "clawdis-gateway.lock");

function killPid(pid: number, reason: string) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`sent SIGTERM to ${pid} (${reason})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      console.log(`pid ${pid} (${reason}) not running`);
    } else {
      console.error(`failed to kill ${pid} (${reason}): ${String(err)}`);
    }
  }
}

function killLockHolder(lockPath: string) {
  if (!fs.existsSync(lockPath)) return;
  try {
    const contents = fs.readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(contents.split("\n")[0] ?? "", 10);
    if (Number.isFinite(pid)) {
      killPid(pid, "gateway lock holder");
    }
  } catch (err) {
    console.error(`failed to read lock ${lockPath}: ${String(err)}`);
  }
}

function cleanupLock(lockPath: string) {
  if (!fs.existsSync(lockPath)) return;
  try {
    fs.rmSync(lockPath, { force: true });
    console.log(`removed gateway lock: ${lockPath}`);
  } catch (err) {
    console.error(`failed to remove lock ${lockPath}: ${String(err)}`);
  }
}

function killGatewayListeners(port: number): PortProcess[] {
  try {
    const killed = forceFreePort(port);
    if (killed.length > 0) {
      console.log(
        `freed port ${port}; terminated: ${killed
          .map((p) => `${p.command} (pid ${p.pid})`)
          .join(", ")}`,
      );
    } else {
      console.log(`port ${port} already free`);
    }
    return killed;
  } catch (err) {
    console.error(`failed to free port ${port}: ${String(err)}`);
    return [];
  }
}

function runTests() {
  const isolatedLock =
    process.env.CLAWDIS_GATEWAY_LOCK ??
    path.join(os.tmpdir(), `clawdis-gateway.lock.test.${Date.now()}`);
  const result = spawnSync("pnpm", ["vitest", "run"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAWDIS_GATEWAY_LOCK: isolatedLock,
    },
  });
  if (result.error) {
    console.error(`pnpm test failed to start: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function main() {
  const port = Number.parseInt(
    process.env.CLAWDIS_GATEWAY_PORT ?? `${DEFAULT_PORT}`,
    10,
  );
  const lockPath = process.env.CLAWDIS_GATEWAY_LOCK ?? DEFAULT_LOCK;

  console.log(`🧹 test:force - clearing gateway on port ${port}`);
  killLockHolder(lockPath);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    console.log("no listeners to kill");
  }

  cleanupLock(lockPath);
  console.log("running pnpm test…");
  runTests();
}

main();
