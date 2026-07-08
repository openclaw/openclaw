/**
 * Self-contained real-behavior proof for PR #101767 (fixes #101718).
 *
 * Drives the REAL `resolveParentForkDecision` / `forkSessionEntryFromParent`
 * against REAL transcript files on disk, with injected filesystem latency that
 * simulates a slow mount (NFS / FUSE / saturated SSD) — the exact scenario in
 * the issue. No mocks: the production modules and Node's real `fs` do the work.
 *
 * It proves the fix's two guarantees:
 *   1. Bounded: parent-fork token resolution never blocks longer than the 2s
 *      deadline (+ a 1s stat fallback), even when the transcript read hangs.
 *   2. Safe: when the size cannot be confirmed in time, the parent is SKIPPED
 *      (isolated context) instead of forked into the unbounded whole-file read
 *      flagged by review — an oversized parent is still caught by a fast,
 *      stat-only byte estimate.
 *
 * Usage: npx tsx scripts/proof-session-fork-timeout.ts
 */
import { execSync } from "node:child_process";
import nodeFs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Inject filesystem latency (simulate a slow mount) ────────────────
let openDelayMs = 0;
let statDelayMs = 0;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const realOpen = nodeFs.promises.open.bind(nodeFs.promises);
// The bounded transcript tail read opens the file handle here.
nodeFs.promises.open = (async (...args: unknown[]) => {
  if (openDelayMs > 0) {
    await sleep(openDelayMs);
  }
  return (realOpen as (...a: unknown[]) => unknown)(...args);
}) as typeof nodeFs.promises.open;

// `stat` backs both the byte-estimate fallback (node:fs/promises) and the tail
// reader (node:fs.promises); patch every distinct object they reference.
for (const target of new Set<{ stat: unknown }>([fsp, nodeFs.promises])) {
  const realStat = (target.stat as (...a: unknown[]) => unknown).bind(target);
  (target as { stat: unknown }).stat = async (...args: unknown[]) => {
    if (statDelayMs > 0) {
      await sleep(statDelayMs);
    }
    return realStat(...args);
  };
}

// Import the REAL production modules only after fs is instrumented.
const { resolveParentForkDecision, forkSessionEntryFromParent } =
  await import("../src/auto-reply/reply/session-fork.js");
const { resolveParentForkTokenCountRuntime } =
  await import("../src/auto-reply/reply/session-fork.runtime.js");

// ── Fixture: a real on-disk parent transcript of a chosen size ───────
const roots: string[] = [];
async function makeParent(targetBytes: number): Promise<{
  storePath: string;
  parentEntry: { sessionId: string; sessionFile: string; updatedAt: number };
  parentSessionKey: string;
  sessionKey: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-fork-proof-"));
  roots.push(root);
  const parentFile = path.join(root, "parent.jsonl");
  const line = `${JSON.stringify({
    type: "message",
    id: "x",
    parentId: null,
    message: { role: "assistant", content: "y".repeat(240) },
  })}\n`;
  let buf = `${JSON.stringify({ type: "session", cwd: root, id: "hdr" })}\n`;
  while (Buffer.byteLength(buf) < targetBytes) {
    buf += line;
  }
  await fsp.writeFile(parentFile, buf, "utf-8");
  const storePath = path.join(root, "sessions.json");
  const parentSessionKey = "agent:main:main";
  const sessionKey = "agent:main:subagent:child";
  await fsp.writeFile(
    storePath,
    JSON.stringify({
      [parentSessionKey]: { sessionId: "parent-session", sessionFile: parentFile, updatedAt: 1 },
      [sessionKey]: { sessionId: "", updatedAt: 2 },
    }),
    "utf-8",
  );
  return {
    storePath,
    parentEntry: { sessionId: "parent-session", sessionFile: parentFile, updatedAt: 1 },
    parentSessionKey,
    sessionKey,
  };
}

// ── Harness plumbing ─────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} — ${detail}`);
  }
};

console.log("PR #101767 real-behavior proof (#101718) — slow-filesystem parent fork\n");
console.log(`HEAD: ${execSync("git rev-parse --short HEAD").toString().trim()}`);
console.log(
  `worktree: ${execSync("git status --porcelain").toString().trim() ? "dirty (fix applied)" : "clean"}\n`,
);

const KB = 1024;
const LARGE_BYTES = 600 * KB; // 600KB ⇒ byte estimate ≈ 150K tokens (> 100K cap)
const SMALL_BYTES = 2 * KB; // 2KB   ⇒ byte estimate ≈ 512 tokens (< cap)

// ── Baseline: the read the deadline must guard is genuinely unbounded ─
{
  const { storePath, parentEntry } = await makeParent(LARGE_BYTES);
  openDelayMs = 3_000;
  statDelayMs = 0;
  const t0 = Date.now();
  await resolveParentForkTokenCountRuntime({ parentEntry, storePath });
  const dt = Date.now() - t0;
  check(
    "Baseline: raw token resolution blocks on a slow transcript read",
    dt >= 2_800,
    `unguarded runtime took ${dt}ms (this is what the 2s deadline must bound)`,
  );
}

// ── Case 1: slow read + OVERSIZED parent ⇒ bounded SKIP, no fork read ─
{
  const fixture = await makeParent(LARGE_BYTES);
  openDelayMs = 3_000;
  statDelayMs = 0;
  const t0 = Date.now();
  const decision = await resolveParentForkDecision({
    parentEntry: fixture.parentEntry,
    agentId: "main",
    storePath: fixture.storePath,
  });
  const dt = Date.now() - t0;
  check(
    "Case 1a: oversized parent decision is bounded by the deadline",
    dt < 2_900,
    `decided in ${dt}ms (< 2.9s) instead of blocking on the 3s read`,
  );
  check(
    "Case 1b: oversized parent SKIPS the fork via the stat-only estimate",
    decision.status === "skip" && decision.reason === "parent-too-large",
    `decision=${decision.status}/${"reason" in decision ? decision.reason : "-"}`,
  );

  // End-to-end: the storage-boundary entry point must not enter the fork read.
  const t1 = Date.now();
  const result = await forkSessionEntryFromParent({
    agentId: "main",
    fallbackEntry: { sessionId: "", updatedAt: 2 },
    parentSessionKey: fixture.parentSessionKey,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
  });
  const dt1 = Date.now() - t1;
  check(
    "Case 1c: forkSessionEntryFromParent returns skipped (no whole-file read)",
    result.status === "skipped" && dt1 < 2_900,
    `status=${result.status} in ${dt1}ms`,
  );
}

// ── Case 2: slow read + SMALL parent ⇒ bounded FORK, estimate preserved ─
{
  const fixture = await makeParent(SMALL_BYTES);
  openDelayMs = 3_000;
  statDelayMs = 0;
  const t0 = Date.now();
  const decision = await resolveParentForkDecision({
    parentEntry: fixture.parentEntry,
    agentId: "main",
    storePath: fixture.storePath,
  });
  const dt = Date.now() - t0;
  const parentTokens = decision.status === "fork" ? decision.parentTokens : undefined;
  check(
    "Case 2: small parent forks with a preserved conservative estimate",
    decision.status === "fork" && typeof parentTokens === "number" && dt < 2_900,
    `decision=${decision.status} parentTokens=${String(parentTokens)} in ${dt}ms`,
  );
}

// ── Case 3: slow read AND slow stat ⇒ bounded SKIP (unresolved) ───────
{
  const fixture = await makeParent(LARGE_BYTES);
  openDelayMs = 3_000;
  statDelayMs = 3_000;
  const t0 = Date.now();
  const decision = await resolveParentForkDecision({
    parentEntry: fixture.parentEntry,
    agentId: "main",
    storePath: fixture.storePath,
  });
  const dt = Date.now() - t0;
  check(
    "Case 3a: unresolvable size is still bounded (deadline + stat fallback)",
    dt < 3_900,
    `decided in ${dt}ms even with stat itself hanging`,
  );
  check(
    "Case 3b: unresolvable size SKIPS conservatively instead of forking",
    decision.status === "skip" && decision.reason === "parent-size-unresolved",
    `decision=${decision.status}/${"reason" in decision ? decision.reason : "-"}`,
  );
}

// ── Cleanup + summary ────────────────────────────────────────────────
openDelayMs = 0;
statDelayMs = 0;
await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
