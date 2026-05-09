import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

import { validateConnectParams } from "../../src/gateway/protocol/index.ts";
import {
  ED25519_RAW_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS,
  MAX_DEVICE_SIGNATURE_INPUT_CHARS,
  isPlausibleDevicePublicKeyInput,
  isPlausibleDeviceSignatureInput,
  verifyDeviceSignature,
} from "../../src/infra/device-identity.ts";
import { createAuthRateLimiter } from "../../src/gateway/auth-rate-limit.ts";

const baseConnect = {
  minProtocol: 1,
  maxProtocol: 1,
  client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
  caps: [],
  commands: [],
  role: "operator",
  scopes: ["operator.read"],
};

console.log("Pre-auth device-signature CPU-DoS proof (PR 77492)");
console.log("Imports real patched validateConnectParams + isPlausibleDevice* + AuthRateLimiter");
console.log("from security/preauth-signature-rate-limit worktree.");
console.log("");
console.log(`MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS = ${MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS}`);
console.log(`MAX_DEVICE_SIGNATURE_INPUT_CHARS  = ${MAX_DEVICE_SIGNATURE_INPUT_CHARS}`);
console.log(`ED25519_RAW_PUBLIC_KEY_BYTES      = ${ED25519_RAW_PUBLIC_KEY_BYTES}`);
console.log(`ED25519_SIGNATURE_BYTES           = ${ED25519_SIGNATURE_BYTES}`);
console.log("");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const realPemPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const realRawPublicKey = publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("base64url");
const validSignature = crypto.sign(null, Buffer.from("test-payload"), privateKey).toString("base64url");

console.log("=== Layer 1: schema-level rejection of oversized device.publicKey / device.signature ===");
console.log("");
const schemaCases: Array<[string, unknown, boolean]> = [
  [
    `valid: device.publicKey real PEM (${realPemPublicKey.length} chars)`,
    { ...baseConnect, device: { id: "x".repeat(64), publicKey: realPemPublicKey, signature: validSignature, signedAt: Date.now(), nonce: "n" } },
    true,
  ],
  [
    `reject: device.publicKey at ${MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS + 1} chars (cap+1)`,
    { ...baseConnect, device: { id: "x".repeat(64), publicKey: "P".repeat(MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS + 1), signature: validSignature, signedAt: Date.now(), nonce: "n" } },
    false,
  ],
  [
    `reject: device.publicKey at 60KB (representative attacker payload)`,
    { ...baseConnect, device: { id: "x".repeat(64), publicKey: "P".repeat(60 * 1024), signature: validSignature, signedAt: Date.now(), nonce: "n" } },
    false,
  ],
  [
    `reject: device.signature at ${MAX_DEVICE_SIGNATURE_INPUT_CHARS + 1} chars (cap+1)`,
    { ...baseConnect, device: { id: "x".repeat(64), publicKey: realPemPublicKey, signature: "S".repeat(MAX_DEVICE_SIGNATURE_INPUT_CHARS + 1), signedAt: Date.now(), nonce: "n" } },
    false,
  ],
];

console.log("case                                                          | result | took");
console.log("--------------------------------------------------------------|--------|------");
for (const [label, payload, expected] of schemaCases) {
  const t0 = performance.now();
  const ok = Boolean(validateConnectParams(payload));
  const ms = performance.now() - t0;
  const matches = ok === expected;
  console.log(
    `${label.padEnd(62)}| ${ok ? "PASS  " : "REJECT"} | ${ms.toFixed(3)}ms ${matches ? "" : "  *** UNEXPECTED ***"}`,
  );
}

console.log("");
console.log("=== Layer 2: shape pre-check on device-identity helpers (no crypto) ===");
console.log("");
const shapeCases: Array<[string, () => boolean, boolean]> = [
  [`valid: real raw 32-byte base64url public key`, () => isPlausibleDevicePublicKeyInput(realRawPublicKey), true],
  [`valid: real PEM public key`, () => isPlausibleDevicePublicKeyInput(realPemPublicKey), true],
  [`reject: random 100-byte base64`, () => isPlausibleDevicePublicKeyInput(crypto.randomBytes(100).toString("base64url")), false],
  [`reject: oversized publicKey (cap+1)`, () => isPlausibleDevicePublicKeyInput("P".repeat(MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS + 1)), false],
  [`reject: empty publicKey`, () => isPlausibleDevicePublicKeyInput(""), false],
  [`valid: real 64-byte base64url signature`, () => isPlausibleDeviceSignatureInput(validSignature), true],
  [`reject: random 32-byte signature input`, () => isPlausibleDeviceSignatureInput(crypto.randomBytes(32).toString("base64url")), false],
  [`reject: oversized signature (cap+1)`, () => isPlausibleDeviceSignatureInput("S".repeat(MAX_DEVICE_SIGNATURE_INPUT_CHARS + 1)), false],
  [`reject: 60KB signature`, () => isPlausibleDeviceSignatureInput("S".repeat(60 * 1024)), false],
];

console.log("case                                                          | result | took");
console.log("--------------------------------------------------------------|--------|------");
for (const [label, fn, expected] of shapeCases) {
  const t0 = performance.now();
  const ok = fn();
  const ms = performance.now() - t0;
  const matches = ok === expected;
  console.log(
    `${label.padEnd(62)}| ${ok ? "PASS  " : "REJECT"} | ${ms.toFixed(3)}ms ${matches ? "" : "  *** UNEXPECTED ***"}`,
  );
}

console.log("");
console.log("=== Layer 3: rate-limit gate AUTH_RATE_LIMIT_SCOPE_DEVICE_SIGNATURE ===");
console.log("");
const rateLimiter = createAuthRateLimiter({
  maxAttempts: 3,
  windowMs: 60_000,
  lockoutMs: 60_000,
  exemptLoopback: false,
  pruneIntervalMs: 0,
});

const ATTACKER_IP = "203.0.113.42";
function gateAttempt(ip: string) {
  const check = rateLimiter.check(ip, "device-signature");
  if (!check.allowed) {
    return { rateLimited: true, retryAfterMs: check.retryAfterMs };
  }
  rateLimiter.recordFailure(ip, "device-signature");
  return { rateLimited: false, remaining: check.remaining };
}

console.log("attempt | rateLimited | remaining/retryAfterMs | crypto entered?");
console.log("--------|-------------|------------------------|------------------");
for (let i = 1; i <= 8; i += 1) {
  const r = gateAttempt(ATTACKER_IP);
  const cell = r.rateLimited ? `retryAfterMs=${r.retryAfterMs}` : `remaining=${r.remaining}`;
  console.log(
    `   ${String(i).padStart(2)}   | ${String(r.rateLimited).padEnd(11)} | ${cell.padEnd(22)} | ${r.rateLimited ? "skipped" : "would enter"}`,
  );
}
console.log("");

console.log("=== Layer 3b: cost comparison — skipped vs entered ===");
console.log("");
let skippedT = 0, enteredT = 0;
const fresh = createAuthRateLimiter({ maxAttempts: 3, exemptLoopback: false, pruneIntervalMs: 0 });
for (let i = 0; i < 3; i += 1) fresh.recordFailure("203.0.113.99", "device-signature");

const ITERS = 5_000;
let t0 = performance.now();
for (let i = 0; i < ITERS; i += 1) {
  const c = fresh.check("203.0.113.99", "device-signature");
  if (c.allowed) {
    crypto.createPublicKey(realPemPublicKey);
    verifyDeviceSignature("test-payload", validSignature, realPemPublicKey);
  }
}
skippedT = performance.now() - t0;

const fresh2 = createAuthRateLimiter({ maxAttempts: 3, exemptLoopback: false, pruneIntervalMs: 0 });
t0 = performance.now();
for (let i = 0; i < ITERS; i += 1) {
  crypto.createPublicKey(realPemPublicKey);
  verifyDeviceSignature("test-payload", validSignature, realPemPublicKey);
}
enteredT = performance.now() - t0;

console.log(`crypto entered ${ITERS} times: ${enteredT.toFixed(1)}ms (avg ${(enteredT / ITERS).toFixed(3)}ms/op)`);
console.log(`gate-blocked  ${ITERS} times: ${skippedT.toFixed(1)}ms (avg ${(skippedT / ITERS).toFixed(3)}ms/op)`);
console.log(`amplification factor under attack: ${(enteredT / skippedT).toFixed(1)}x`);
console.log("");
console.log("=== Summary ===");
console.log(`Layer 1: schema caps reject oversized device.publicKey / device.signature in <1ms`);
console.log(`Layer 2: shape pre-checks reject malformed inputs without invoking crypto`);
console.log(`Layer 3: after 3 failures, attempts 4-8 short-circuit before createPublicKey + verify`);
console.log(`         crypto saved per attacker request: ~${(enteredT / ITERS).toFixed(3)}ms`);

rateLimiter.dispose();
fresh.dispose();
fresh2.dispose();
