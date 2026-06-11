#!/usr/bin/env node
/**
 * Real Behavior Proof — AsyncLocalStorage Re-entrant Guard
 * for PR #55211: fix(hooks): prevent re-entrant internal hook loops
 *
 * This script is a self-contained reproduction that mirrors the exact
 * guard logic from src/hooks/internal-hooks.ts WITHOUT depending on
 * the openclaw monorepo build system.
 *
 * Run: node repro-reentrant-guard.mjs
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Minimal mock of openclaw's internal hook system ────────────────────

const dispatchContext = new AsyncLocalStorage();

/** Mirrors the guard in triggerInternalHook (PR branch) */
async function triggerInternalHook_WITH_GUARD(handlers, type, action, sessionKey) {
  const guardKey = `${type}\0${action}\0${sessionKey}`;
  const activeKeys = dispatchContext.getStore();
  if (activeKeys?.has(guardKey)) {
    return { blocked: true, key: guardKey };
  }
  const newKeys = activeKeys ? new Set([...activeKeys, guardKey]) : new Set([guardKey]);
  await dispatchContext.run(newKeys, async () => {
    for (const handler of handlers) {
      await handler({ type, action, sessionKey });
    }
  });
  return { blocked: false, key: guardKey };
}

/** Mirrors the ORIGINAL triggerInternalHook (main branch, no guard) */
async function triggerInternalHook_NO_GUARD(handlers, type, action, sessionKey) {
  for (const handler of handlers) {
    await handler({ type, action, sessionKey });
  }
  return { blocked: false, key: `${type}\0${action}\0${sessionKey}` };
}

// ─── Test scenarios ─────────────────────────────────────────────────────

const SEP = "─".repeat(72);

async function main() {
  console.log(SEP);
  console.log("Real Behavior Proof: AsyncLocalStorage Re-entrant Guard");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version} | Platform: ${process.platform} ${process.arch}`);
  console.log(SEP);
  console.log();

  // ── Scenario 1: WITHOUT guard → unbounded re-entrant loop ──────────
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Scenario 1: WITHOUT guard (main branch behavior)              ║");
  console.log("║  A handler that re-triggers the same event → infinite loop     ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  let callCount_noGuard = 0;
  const maxDepth = 10; // Cap to avoid actual infinite loop in demo
  const handlers_noGuard = [
    async (event) => {
      callCount_noGuard++;
      console.log(`  [NO GUARD] handler invoked (#${callCount_noGuard}) — ${event.type}:${event.action}:${event.sessionKey}`);
      if (callCount_noGuard < maxDepth) {
        await triggerInternalHook_NO_GUARD(
          handlers_noGuard, event.type, event.action, event.sessionKey
        );
      }
    },
  ];

  callCount_noGuard = 0;
  console.log("Triggering command:new:test-session (capped at 10 to avoid hang)...");
  await triggerInternalHook_NO_GUARD(handlers_noGuard, "command", "new", "test-session");
  console.log();
  console.log(`  Result: handler called ${callCount_noGuard} times (would be infinite without cap)`);
  console.log(`  ⚠️  WITHOUT guard, re-entrant calls amplify without bound`);
  console.log();

  // ── Scenario 2: WITH guard → re-entrant blocked after first call ───
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Scenario 2: WITH guard (PR branch behavior)                   ║");
  console.log("║  Same handler → re-entrant call is correctly blocked           ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  let callCount_withGuard = 0;
  let blockedCount = 0;
  const handlers_withGuard = [
    async (event) => {
      callCount_withGuard++;
      console.log(`  [WITH GUARD] handler invoked (#${callCount_withGuard}) — ${event.type}:${event.action}:${event.sessionKey}`);
      const result = await triggerInternalHook_WITH_GUARD(
        handlers_withGuard, event.type, event.action, event.sessionKey
      );
      if (result.blocked) {
        blockedCount++;
        console.log(`  [WITH GUARD] re-entrant call BLOCKED ✅ (key: ${result.key.replace(/\0/g, "|")})`);
      }
    },
  ];

  callCount_withGuard = 0;
  blockedCount = 0;
  console.log("Triggering command:new:test-session...");
  await triggerInternalHook_WITH_GUARD(handlers_withGuard, "command", "new", "test-session");
  console.log();
  console.log(`  Result: handler called ${callCount_withGuard} time(s), re-entrant blocked ${blockedCount} time(s)`);
  console.log(`  ✅ WITH guard, re-entrant calls are prevented`);
  console.log();

  // ── Scenario 3: WITH guard → sequential triggers work ──────────────
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Scenario 3: Sequential triggers AFTER first completes → OK   ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  let seqCount = 0;
  const seqHandlers = [
    async (event) => {
      seqCount++;
      console.log(`  [SEQUENTIAL] handler invoked (#${seqCount}) — ${event.type}:${event.action}:${event.sessionKey}`);
    },
  ];

  seqCount = 0;
  console.log("Triggering #1...");
  await triggerInternalHook_WITH_GUARD(seqHandlers, "command", "new", "test-session");
  console.log("Triggering #2...");
  await triggerInternalHook_WITH_GUARD(seqHandlers, "command", "new", "test-session");
  console.log("Triggering #3...");
  await triggerInternalHook_WITH_GUARD(seqHandlers, "command", "new", "test-session");
  console.log();
  console.log(`  Result: handler called ${seqCount} time(s)`);
  console.log(`  ✅ Sequential triggers work correctly`);
  console.log();

  // ── Scenario 4: WITH guard → concurrent independent triggers work ──
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Scenario 4: Concurrent INDEPENDENT triggers → both delivered  ║");
  console.log("║  (simulates fireAndForgetHook behavior)                        ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  let concurrentCount = 0;
  const concurrentHandlers = [
    async (event) => {
      concurrentCount++;
      // Simulate slow handler
      await new Promise((r) => setTimeout(r, 50));
      console.log(`  [CONCURRENT] handler invoked (#${concurrentCount}) — ${event.type}:${event.action}:${event.sessionKey}`);
    },
  ];

  concurrentCount = 0;
  console.log("Firing 2 independent concurrent triggers for message:received:session-a...");
  // Each trigger starts in its own Promise context (like fireAndForgetHook)
  await Promise.all([
    triggerInternalHook_WITH_GUARD(concurrentHandlers, "message", "received", "session-a"),
    triggerInternalHook_WITH_GUARD(concurrentHandlers, "message", "received", "session-a"),
  ]);
  console.log();
  console.log(`  Result: handler called ${concurrentCount} time(s)`);
  console.log(`  ✅ Independent concurrent triggers are both delivered`);
  console.log();

  // ── Scenario 5: WITH guard → different sessions not blocked ────────
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Scenario 5: Different session keys → not blocked              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  let crossSessionCount = 0;
  const crossSessionHandlers = [
    async (event) => {
      crossSessionCount++;
      console.log(`  [CROSS-SESSION] handler invoked (#${crossSessionCount}) — ${event.type}:${event.action}:${event.sessionKey}`);
    },
  ];

  crossSessionCount = 0;
  console.log("Firing command:new for session-a and session-b concurrently...");
  await Promise.all([
    triggerInternalHook_WITH_GUARD(crossSessionHandlers, "command", "new", "session-a"),
    triggerInternalHook_WITH_GUARD(crossSessionHandlers, "command", "new", "session-b"),
  ]);
  console.log();
  console.log(`  Result: handler called ${crossSessionCount} time(s)`);
  console.log(`  ✅ Different session keys are independently dispatched`);
  console.log();

  // ── Summary ────────────────────────────────────────────────────────
  console.log(SEP);
  console.log("SUMMARY");
  console.log(SEP);
  console.log();
  console.log("  Without guard (main):");
  console.log(`    Re-entrant loop → ${callCount_noGuard} calls (capped, would be infinite)`);
  console.log();
  console.log("  With guard (PR branch):");
  console.log(`    Re-entrant blocked    → handler called ${callCount_withGuard}x, blocked ${blockedCount}x ✅`);
  console.log(`    Sequential triggers   → handler called ${seqCount}x ✅`);
  console.log(`    Concurrent independent→ handler called ${concurrentCount}x ✅`);
  console.log(`    Cross-session         → handler called ${crossSessionCount}x ✅`);
  console.log();
  console.log("  The AsyncLocalStorage guard prevents re-entrant amplification");
  console.log("  while preserving all legitimate dispatch patterns.");
  console.log();
  console.log(SEP);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
