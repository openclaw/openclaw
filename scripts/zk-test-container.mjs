/**
 * ZK Container Test
 *
 * Standalone ES module — only uses node:crypto (no source imports, no pnpm).
 * Run inside the container:
 *
 *   docker compose exec -T openclaw-gateway node scripts/zk-test-container.mjs
 *
 * Or from the host (after docker cp):
 *
 *   docker cp scripts/zk-test-container.mjs openclaw-openclaw-gateway-1:/tmp/
 *   docker compose exec -T openclaw-gateway node /tmp/zk-test-container.mjs
 *
 * Tests all ZKP operations that live in:
 *   src/infra/zk-agent-trust.ts   (policy, proof, verify)
 *   src/agents/zk-handoff.ts      (capsule create, receive, replay, tamper)
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};
const pass = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);
const fail = (msg) => console.log(`  ${C.red}✗${C.reset} ${msg}`);
const info = (msg) => console.log(`  ${C.dim}→${C.reset} ${msg}`);
const head = (msg) => console.log(`\n${C.bold}${C.cyan}${msg}${C.reset}`);
const warn = (msg) => console.log(`  ${C.yellow}⚠${C.reset}  ${msg}`);

let passed = 0,
  failed = 0;
function assert(condition, label) {
  if (condition) {
    pass(label);
    passed++;
  } else {
    fail(label);
    failed++;
  }
}

// ── Inline ZK primitives (mirrors zk-agent-trust.ts + zk-handoff.ts) ─────────

/** SHA-256 hex of a string */
function sha256hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Build a Merkle root over an array of hex leaf hashes */
function merkleRoot(leaves) {
  if (leaves.length === 0) {
    return sha256hex("empty");
  }
  let layer = [...leaves];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? left;
      next.push(
        createHash("sha256")
          .update(left + right, "utf8")
          .digest("hex"),
      );
    }
    layer = next;
  }
  return layer[0];
}

/** Issue an access policy (mirrors issueAccessPolicy) */
function issueAccessPolicy({ agentId, sessionId, allowedResources, gatewayKey }) {
  const resourceHashes = allowedResources.map((r) => sha256hex(r));
  const policyRoot = merkleRoot(resourceHashes);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 300_000;
  const policyMac = createHmac("sha256", gatewayKey)
    .update(`${agentId}:${sessionId}:${policyRoot}:${issuedAt}`, "utf8")
    .digest("hex");
  return {
    agentId,
    sessionId,
    allowedResources,
    resourceHashes,
    policyRoot,
    policyMac,
    issuedAt,
    expiresAt,
  };
}

/** Record accesses + generate proof (mirrors AccessWitnessRecorder) */
function generateProof(agentId, sessionId, accesses, policy, gatewayKey) {
  const accessHashes = accesses.map((r) => sha256hex(r));
  const accessRoot = merkleRoot(accessHashes);
  // Verify all accessed resources were in policy
  for (const h of accessHashes) {
    if (!policy.resourceHashes.includes(h)) {
      throw new Error(`resource not in policy: ${h}`);
    }
  }
  const commitInput = `${agentId}:${sessionId}:${accessRoot}:${policy.policyRoot}`;
  const commitment = createHmac("sha256", gatewayKey).update(commitInput, "utf8").digest("hex");
  return {
    agentId,
    sessionId,
    accessRoot,
    policyRoot: policy.policyRoot,
    commitment,
    proofType: "commitment-v1",
    numAccesses: accesses.length,
  };
}

/** Verify a proof (mirrors verifyAccessProof) */
function verifyProof(proof, gatewayKey, policy) {
  const commitInput = `${proof.agentId}:${proof.sessionId}:${proof.accessRoot}:${proof.policyRoot}`;
  const expected = createHmac("sha256", gatewayKey).update(commitInput, "utf8").digest("hex");
  if (proof.commitment.length !== expected.length) {
    return { valid: false, reason: "commitment length mismatch" };
  }
  const match = timingSafeEqual(Buffer.from(proof.commitment, "hex"), Buffer.from(expected, "hex"));
  if (!match) {
    return { valid: false, reason: "commitment MAC invalid" };
  }
  if (proof.policyRoot !== policy.policyRoot) {
    return { valid: false, reason: "policy root mismatch" };
  }
  return { valid: true };
}

/** Derive AES key via HKDF (mirrors deriveEncryptionKey) */
function deriveEncryptionKey(gatewayKey, senderAgentId, receiverAgentId, handoffNonce) {
  const salt = Buffer.from(handoffNonce, "base64url");
  const info = Buffer.from(`zk-handoff:${senderAgentId}:${receiverAgentId}`, "utf8");
  return Buffer.from(hkdfSync("sha256", gatewayKey, salt, info, 32));
}

/** Timing-safe hex compare */
function safeHexEq(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Create a handoff capsule (mirrors createHandoffCapsule) */
function createHandoffCapsule({
  senderAgentId,
  receiverAgentId,
  task,
  taskLabel,
  state,
  authorizedChannelIds,
  authorizedResourceIds,
  gatewayKey,
  accessProof,
  ttlMs = 300_000,
}) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const handoffNonce = randomBytes(32).toString("base64url");
  const taskHash = sha256hex(task);

  const capInput = Buffer.from(
    `${senderAgentId}:${receiverAgentId}:${taskHash}:${handoffNonce}:${issuedAt}`,
    "utf8",
  );
  const capProof = createHmac("sha256", gatewayKey).update(capInput).digest("hex");

  const encKey = deriveEncryptionKey(gatewayKey, senderAgentId, receiverAgentId, handoffNonce);
  const context = { task, state, authorizedChannelIds, authorizedResourceIds };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(context), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const encCtx = encrypted.toString("base64url");
  const ctxIv = iv.toString("base64url");
  const ctxTag = tag.toString("base64url");
  const handoffHash = createHash("sha256")
    .update(capProof, "hex")
    .update(encCtx)
    .update(ctxIv)
    .digest("hex");

  return {
    header: {
      senderAgentId,
      receiverAgentId,
      taskHash,
      taskLabel,
      issuedAt,
      expiresAt,
      handoffNonce,
    },
    capabilityProof: capProof,
    encryptedContext: encCtx,
    contextIv: ctxIv,
    contextTag: ctxTag,
    handoffHash,
    accessProof,
  };
}

/** Receive + verify a capsule (mirrors receiveHandoffCapsule) */
function receiveHandoffCapsule(capsule, receiverAgentId, gatewayKey) {
  const { header } = capsule;
  if (header.receiverAgentId !== receiverAgentId) {
    return { valid: false, reason: "capsule not addressed to this agent" };
  }
  if (Date.now() > header.expiresAt) {
    return { valid: false, reason: "handoff capsule has expired" };
  }

  const expectedHash = createHash("sha256")
    .update(capsule.capabilityProof, "hex")
    .update(capsule.encryptedContext)
    .update(capsule.contextIv)
    .digest("hex");
  if (!safeHexEq(capsule.handoffHash, expectedHash)) {
    return { valid: false, reason: "integrity check failed" };
  }

  const capInput = Buffer.from(
    `${header.senderAgentId}:${header.receiverAgentId}:${header.taskHash}:${header.handoffNonce}:${header.issuedAt}`,
    "utf8",
  );
  const expected = createHmac("sha256", gatewayKey).update(capInput).digest("hex");
  if (!safeHexEq(capsule.capabilityProof, expected)) {
    return { valid: false, reason: "capability proof MAC invalid" };
  }

  try {
    const encKey = deriveEncryptionKey(
      gatewayKey,
      header.senderAgentId,
      header.receiverAgentId,
      header.handoffNonce,
    );
    const iv = Buffer.from(capsule.contextIv, "base64url");
    const tagBuf = Buffer.from(capsule.contextTag, "base64url");
    const cipherBuf = Buffer.from(capsule.encryptedContext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
    decipher.setAuthTag(tagBuf);
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return { valid: true, context: JSON.parse(plain.toString("utf8")) };
  } catch {
    return { valid: false, reason: "decryption failed — tampered ciphertext" };
  }
}

// ── Nonce registry ────────────────────────────────────────────────────────────
class NonceRegistry {
  #seen = new Map();
  checkAndRegister(nonce, expiresAt) {
    if (this.#seen.has(nonce)) {
      return true;
    } // replay
    this.#seen.set(nonce, expiresAt);
    return false;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}OpenClaw ZKP Container Test${C.reset}`);
  console.log(`${C.dim}Node ${process.version} — only node:crypto, no source imports${C.reset}`);

  const gatewayKey = randomBytes(32);
  const allowedResources = ["research:web-search", "research:summarise", "messages:read"];

  // ── 1. Policy issuance ────────────────────────────────────────────────────
  head("1. Access Policy");
  const policy = issueAccessPolicy({
    agentId: "planner",
    sessionId: "sess-1",
    allowedResources,
    gatewayKey,
  });
  assert(
    typeof policy.policyRoot === "string" && policy.policyRoot.length === 64,
    "policyRoot is 64-char hex",
  );
  assert(policy.resourceHashes.length === 3, "3 resource hashes");
  assert(typeof policy.policyMac === "string", "policyMac present");
  info(`policyRoot: ${policy.policyRoot.slice(0, 16)}…`);

  // ── 2. Access proof ───────────────────────────────────────────────────────
  head("2. Proof Generation & Verification");
  const proof = generateProof(
    "planner",
    "sess-1",
    ["research:web-search", "research:summarise"],
    policy,
    gatewayKey,
  );
  assert(proof.numAccesses === 2, "2 accesses recorded (messages:read was in policy but unused)");
  assert(proof.proofType === "commitment-v1", "proofType = commitment-v1");

  const vOk = verifyProof(proof, gatewayKey, policy);
  assert(vOk.valid, "valid proof verifies");

  const wrongKey = randomBytes(32);
  const vBad = verifyProof(proof, wrongKey, policy);
  assert(!vBad.valid, "proof with wrong key is rejected");

  // ── 3. Handoff — happy path ───────────────────────────────────────────────
  head("3. Handoff Capsule — Happy Path");
  const capsule = createHandoffCapsule({
    senderAgentId: "planner",
    receiverAgentId: "researcher",
    task: "Summarise the top 5 AI papers.",
    taskLabel: "AI briefing",
    state: { draft: ["intro", "findings"] },
    authorizedChannelIds: ["imessage:user"],
    authorizedResourceIds: allowedResources,
    gatewayKey,
    accessProof: proof,
    ttlMs: 60_000,
  });
  assert(typeof capsule.handoffHash === "string", "capsule has handoffHash");
  assert(capsule.accessProof !== undefined, "accessProof attached");

  const result = receiveHandoffCapsule(capsule, "researcher", gatewayKey);
  assert(result.valid, "capsule accepted by correct receiver");
  if (result.valid) {
    assert(result.context.task === "Summarise the top 5 AI papers.", "task decrypted correctly");
    assert(
      result.context.authorizedChannelIds[0] === "imessage:user",
      "authorizedChannelIds intact",
    );
    info(`decrypted task: "${result.context.task.slice(0, 40)}…"`);
  }

  // ── 4. Replay protection ──────────────────────────────────────────────────
  head("4. Replay Attack");
  const registry = new NonceRegistry();
  const r1 = registry.checkAndRegister(capsule.header.handoffNonce, capsule.header.expiresAt);
  assert(!r1, "first submission accepted (not a replay)");
  const r2 = registry.checkAndRegister(capsule.header.handoffNonce, capsule.header.expiresAt);
  assert(r2, "second submission rejected as replay");
  warn(`replay detected for nonce: ${capsule.header.handoffNonce.slice(0, 16)}…`);

  // ── 5. Wrong receiver ─────────────────────────────────────────────────────
  head("5. Wrong Receiver (Impersonation)");
  const impersonation = receiveHandoffCapsule(capsule, "evil-agent", gatewayKey);
  assert(!impersonation.valid, "capsule rejected for wrong receiver");
  assert(
    impersonation.reason === "capsule not addressed to this agent",
    `reason: ${impersonation.reason}`,
  );

  // ── 6. Tampered ciphertext ────────────────────────────────────────────────
  head("6. Tampered Ciphertext");
  const tampered = { ...capsule, encryptedContext: capsule.encryptedContext.slice(0, -4) + "AAAA" };
  const tResult = receiveHandoffCapsule(tampered, "researcher", gatewayKey);
  assert(!tResult.valid, "tampered capsule rejected");
  info(`rejection reason: ${tResult.reason}`);

  // ── 7. Tampered capability proof ─────────────────────────────────────────
  head("7. Tampered Capability Proof");
  const badProof = { ...capsule, capabilityProof: "a".repeat(64) };
  // Recompute hash so integrity check passes — only the MAC check should catch it
  const rehashedBad = {
    ...badProof,
    handoffHash: createHash("sha256")
      .update(badProof.capabilityProof, "hex")
      .update(badProof.encryptedContext)
      .update(badProof.contextIv)
      .digest("hex"),
  };
  const macResult = receiveHandoffCapsule(rehashedBad, "researcher", gatewayKey);
  assert(!macResult.valid, "forged capability proof rejected");
  info(`rejection reason: ${macResult.reason}`);

  // ── 8. Wrong gateway key ──────────────────────────────────────────────────
  head("8. Wrong Gateway Key");
  const wrongKeyResult = receiveHandoffCapsule(capsule, "researcher", wrongKey);
  assert(!wrongKeyResult.valid, "capsule rejected with wrong gateway key");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${C.bold}${C.green}All ${total} tests passed ✓${C.reset}`);
  } else {
    console.log(`${C.bold}${C.red}${failed} of ${total} tests FAILED ✗${C.reset}`);
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
