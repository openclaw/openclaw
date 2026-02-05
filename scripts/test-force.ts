#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { forceFreePort, type PortProcess } from "../src/cli/ports.js";

const DEFAULT_PORT = 18789;

const writeStdout = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const writeStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function killGatewayListeners(port: number): PortProcess[] {
  try {
    const killed = forceFreePort(port);
    if (killed.length > 0) {
      writeStdout(
        `freed port ${port}; terminated: ${killed
          .map((p) => `${p.command} (pid ${p.pid})`)
          .join(", ")}`,
      );
    } else {
      writeStdout(`port ${port} already free`);
    }
    return killed;
  } catch (err) {
    writeStderr(`failed to free port ${port}: ${String(err)}`);
    return [];
  }
}

function runTests() {
  const isolatedLock =
    process.env.OPENCLAW_GATEWAY_LOCK ??
    path.join(os.tmpdir(), `openclaw-gateway.lock.test.${Date.now()}`);
  const result = spawnSync("pnpm", ["vitest", "run"], {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_LOCK: isolatedLock,
    },
  });
  if (result.error) {
    writeStderr(`pnpm test failed to start: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function main() {
  const port = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? `${DEFAULT_PORT}`, 10);

  writeStdout(`🧹 test:force - clearing gateway on port ${port}`);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    writeStdout("no listeners to kill");
  }

  writeStdout("running pnpm test…");
  runTests();
}

main();
