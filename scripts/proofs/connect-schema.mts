import { performance } from "node:perf_hooks";

import { validateConnectParams } from "../../src/gateway/protocol/index.ts";
import {
  HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH,
  HANDSHAKE_SHARED_SECRET_MAX_LENGTH,
} from "../../src/gateway/protocol/schema/primitives.ts";

const base = {
  minProtocol: 1,
  maxProtocol: 1,
  client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
  caps: [],
  commands: [],
  role: "operator",
  scopes: ["operator.read"],
};

function time(fn: () => unknown): { ok: boolean; ms: number } {
  const t0 = performance.now();
  const ok = Boolean(fn());
  const ms = performance.now() - t0;
  return { ok, ms };
}

console.log("Connect-frame auth bounds proof (PR 77538)");
console.log("Imports real ajv-compiled validateConnectParams + cap constants");
console.log("from security/connect-schema-auth-bounds worktree.");
console.log("");
console.log(`HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH = ${HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH}`);
console.log(`HANDSHAKE_SHARED_SECRET_MAX_LENGTH   = ${HANDSHAKE_SHARED_SECRET_MAX_LENGTH}`);
console.log("");

const cases: Array<[string, unknown]> = [
  [
    "valid: empty auth",
    { ...base, auth: {} },
  ],
  [
    `valid: bootstrapToken at cap (${HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH} chars)`,
    { ...base, auth: { bootstrapToken: "b".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH) } },
  ],
  [
    `valid: deviceToken at cap (${HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH} chars)`,
    { ...base, auth: { deviceToken: "d".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH) } },
  ],
  [
    `valid: token at cap (${HANDSHAKE_SHARED_SECRET_MAX_LENGTH} chars)`,
    { ...base, auth: { token: "t".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH) } },
  ],
  [
    `valid: password at cap (${HANDSHAKE_SHARED_SECRET_MAX_LENGTH} chars)`,
    { ...base, auth: { password: "p".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH) } },
  ],
  [
    `reject: bootstrapToken cap+1 (${HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH + 1} chars)`,
    { ...base, auth: { bootstrapToken: "b".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH + 1) } },
  ],
  [
    `reject: deviceToken cap+1`,
    { ...base, auth: { deviceToken: "d".repeat(HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH + 1) } },
  ],
  [
    `reject: token cap+1 (${HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1} chars)`,
    { ...base, auth: { token: "t".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1) } },
  ],
  [
    `reject: password cap+1`,
    { ...base, auth: { password: "p".repeat(HANDSHAKE_SHARED_SECRET_MAX_LENGTH + 1) } },
  ],
  [
    `reject: 60KB bootstrapToken (representative attacker payload)`,
    { ...base, auth: { bootstrapToken: "X".repeat(60 * 1024) } },
  ],
  [
    `reject: 60KB token`,
    { ...base, auth: { token: "X".repeat(60 * 1024) } },
  ],
  [
    `reject: 60KB password`,
    { ...base, auth: { password: "X".repeat(60 * 1024) } },
  ],
];

console.log("case                                              | result | took");
console.log("--------------------------------------------------|--------|------");
for (const [label, payload] of cases) {
  const { ok, ms } = time(() => validateConnectParams(payload));
  const expected = label.startsWith("valid:") ? true : false;
  const matches = ok === expected;
  console.log(
    `${label.padEnd(50)}| ${ok ? "PASS  " : "REJECT"} | ${ms.toFixed(3)}ms ${matches ? "" : "  *** UNEXPECTED ***"}`,
  );
}

console.log("");
console.log("=== Comparison: schema rejection vs full safeEqualSecret allocation ===");
console.log("");
const t0 = performance.now();
let n = 0;
const giant = { ...base, auth: { bootstrapToken: "X".repeat(60 * 1024) } };
while (performance.now() - t0 < 100) {
  validateConnectParams(giant);
  n += 1;
}
const elapsed = performance.now() - t0;
console.log(`60KB bootstrapToken rejected ${n} times in ${elapsed.toFixed(1)}ms`);
console.log(`per-rejection cost: ${(elapsed / n).toFixed(4)}ms`);
console.log(
  `(without these caps, every oversized value would propagate to safeEqualSecret`,
);
console.log(
  ` which pads both operands to Math.max and runs timingSafeEqual once per stored entry)`,
);
