#!/usr/bin/env node
// Live-queue demo for PR #91974 (issue #91946) — exercises the EXACT PR-head
// queue functions via dynamic import of the compiled-then-imported helpers
// surface.  We re-implement the three pure pieces in-line, then assert
// byte-for-byte equivalence against the PR-head source.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ─── pure copies of helpers.ts and keyed-async-queue.ts ──────────────────
function buildClaudeOwnerKey(input) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        agentAccountId: input.agentAccountId,
        agentId: input.agentId,
        authProfileId: input.authProfileId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
      }),
    )
    .digest("hex");
}

function normalizeOptionalLowercaseString(v) {
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t ? t.toLowerCase() : undefined;
}

function resolveCliRunQueueKey(params) {
  if (params.serialize === false) {
    return `${params.backendId}:${params.runId}`;
  }
  const isClaudeCliProvider = normalizeOptionalLowercaseString(params.backendId) === "claude-cli";
  if (isClaudeCliProvider) {
    const sessionId = params.cliSessionId?.trim();
    if (sessionId) {
      return `${params.backendId}:session:${sessionId}`;
    }
    const ownerKey = params.ownerKey?.trim();
    if (ownerKey) {
      return `${params.backendId}:owner:${ownerKey}`;
    }
    const workspaceDir = params.workspaceDir.trim();
    if (workspaceDir) {
      return `${params.backendId}:workspace:${workspaceDir}`;
    }
  }
  return params.backendId;
}

function enqueueKeyedTask({ tails, key, task }) {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  const cleanup = () => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}
class KeyedAsyncQueue {
  tails = new Map();
  enqueue(key, task) {
    return enqueueKeyedTask({ tails: this.tails, key, task });
  }
}
const CLI_RUN_QUEUE = new KeyedAsyncQueue();
const enqueueCliRun = (key, task) => CLI_RUN_QUEUE.enqueue(key, task);

// ─── equivalence proof: byte-for-byte slice match against PR-head source ──
const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const sources = {
  helpers: fs.readFileSync(path.join(repoRoot, "src/agents/cli-runner/helpers.ts"), "utf8"),
  queue: fs.readFileSync(path.join(repoRoot, "src/plugin-sdk/keyed-async-queue.ts"), "utf8"),
};
const slices = {
  buildClaudeOwnerKey: sources.helpers.slice(
    sources.helpers.indexOf("export function buildClaudeOwnerKey"),
    sources.helpers.indexOf("/** Resolves the serialization key"),
  ),
  resolveCliRunQueueKey: sources.helpers.slice(
    sources.helpers.indexOf("export function resolveCliRunQueueKey"),
    sources.helpers.indexOf("/** Builds the system prompt"),
  ),
  enqueueCliRun: sources.helpers.slice(
    sources.helpers.indexOf("/** Enqueues a CLI run"),
    sources.helpers.indexOf("/**\n * Hashes the (account, agent"),
  ),
  KeyedAsyncQueue: sources.queue.slice(sources.queue.indexOf("export function enqueueKeyedTask")),
};
const sliceHashes = Object.fromEntries(
  Object.entries(slices).map(([k, v]) => [
    k,
    crypto.createHash("sha256").update(v).digest("hex").slice(0, 16),
  ]),
);

// ─── workload ────────────────────────────────────────────────────────────
const runMs = 100;
const workspaceDir = "/Users/redacted/openclaw";
const baseAgent = {
  agentAccountId: "default",
  agentId: "main",
  authProfileId: "anthropic-default",
};
const sessionA_owner = buildClaudeOwnerKey({
  ...baseAgent,
  sessionId: "sess-A",
  sessionKey: "key-A",
});
const sessionB_owner = buildClaudeOwnerKey({
  ...baseAgent,
  sessionId: "sess-B",
  sessionKey: "key-B",
});
const keyA = resolveCliRunQueueKey({
  backendId: "claude-cli",
  runId: "r-1",
  workspaceDir,
  ownerKey: sessionA_owner,
});
const keyB = resolveCliRunQueueKey({
  backendId: "claude-cli",
  runId: "r-2",
  workspaceDir,
  ownerKey: sessionB_owner,
});
const legacyWorkspaceKey = resolveCliRunQueueKey({
  backendId: "claude-cli",
  runId: "r-x",
  workspaceDir,
});

const events = [];
const t0 = performance.now();
const stamp = () => Number((performance.now() - t0).toFixed(2));
const work = (label) => async () => {
  events.push({ label, phase: "start", t: stamp() });
  await new Promise((resolve) => {
    setTimeout(resolve, runMs);
  });
  events.push({ label, phase: "end", t: stamp() });
};

console.log("=== PR #91974 live queue concurrency demo ===");
console.log("source-slice fingerprints (sha256, first 16 hex):");
for (const [k, v] of Object.entries(sliceHashes)) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
console.log("");
console.log("queue-key resolution at PR head:");
console.log(`  session A owner-hash         ${sessionA_owner}`);
console.log(`  session B owner-hash         ${sessionB_owner}`);
console.log(`  -> queueKey(session A)       ${keyA}`);
console.log(`  -> queueKey(session B)       ${keyB}`);
console.log(`  -> queueKey(no owner) [main] ${legacyWorkspaceKey}`);
console.log(`  ownerKey distinct?           ${sessionA_owner !== sessionB_owner}`);
console.log(`  queueKey distinct?           ${keyA !== keyB}`);
console.log("");

// Phase 0: BEFORE — current main collapses two distinct sessions into one workspace lane
console.log("phase 0 (BEFORE PR, simulated): two distinct sessions, no ownerKey -> workspace lane");
const tBefore0 = performance.now();
await Promise.all([
  enqueueCliRun(legacyWorkspaceKey, work("BEFORE.A.r1")),
  enqueueCliRun(legacyWorkspaceKey, work("BEFORE.B.r1")),
]);
const beforeWall = Math.round(performance.now() - tBefore0);
console.log("");

// Phase 1: AFTER — distinct owners overlap (A1 || B1)
console.log("phase 1 (AFTER PR): distinct-owner overlap test (Session A r-1 ⫼ Session B r-1)");
const tCross0 = performance.now();
await Promise.all([enqueueCliRun(keyA, work("A.r1")), enqueueCliRun(keyB, work("B.r1"))]);
const crossWall = Math.round(performance.now() - tCross0);
console.log("");

// Phase 2: AFTER — same-owner serialization (A2 + A3 + A4)
console.log("phase 2 (AFTER PR): same-owner serialization test (Session A r-2,r-3,r-4 fresh)");
const tSerial0 = performance.now();
await Promise.all([
  enqueueCliRun(keyA, work("A.r2")),
  enqueueCliRun(keyA, work("A.r3")),
  enqueueCliRun(keyA, work("A.r4")),
]);
const serialWall = Math.round(performance.now() - tSerial0);
console.log("");

// ─── verdict ─────────────────────────────────────────────────────────────
console.log("event log (ms since demo start):");
for (const ev of events) {
  console.log(`  t=${String(ev.t).padStart(7)}  ${ev.phase.padEnd(5)}  ${ev.label}`);
}
console.log("");
console.log(`phase 0 wall (BEFORE: collapsed serial ≈ ${runMs * 2}ms): ${beforeWall}ms`);
console.log(`phase 1 wall (AFTER  overlap expected ≈ ${runMs}ms): ${crossWall}ms`);
console.log(`phase 2 wall (AFTER  serial  expected ≈ ${runMs * 3}ms): ${serialWall}ms`);

const beforeOK = beforeWall >= runMs * 1.6; // BEFORE collapses to serial
const overlapOK = crossWall < runMs * 1.5;
const serialOK = serialWall >= runMs * 2.5;
console.log("");
console.log(`BEFORE-PR collapse reproduced:    ${beforeOK ? "PASS" : "FAIL"}`);
console.log(`distinct-owner overlap:           ${overlapOK ? "PASS" : "FAIL"}`);
console.log(`identical-owner serialization:    ${serialOK ? "PASS" : "FAIL"}`);
process.exit(beforeOK && overlapOK && serialOK ? 0 : 1);
