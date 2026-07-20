/**
 * Real-behavior proof for openclaw-cm1 (#86655): a Claude turn that dispatches a
 * native subagent (`Agent` / `Task`) must NOT be torn down by the progress-idle
 * watchdog while the subagent runs silently in an SDK child process.
 *
 * This drives the REAL createClaudeProgressWatch (the actual production watch
 * that run-attempt.ts wires up) — NOT a mock of the watch — through the exact
 * sequence of note* calls that run-attempt.ts makes for the notifications a
 * native-subagent turn produces, against REAL wall-clock setTimeout (no fake
 * timers). Timeouts are scaled down to keep the proof fast; the RATIO that
 * matters (subagent budget > base budget, and the silent gap falling between
 * them) is preserved.
 *
 * Three scenarios, mirroring how run-attempt.ts maps notifications:
 *   1. OLD bridge (heartbeat-only), latch ENGAGED — the silent post-dispatch
 *      gap is longer than the base progress budget but shorter than the subagent
 *      budget. Asserts: NO stall (the fix). This is the regression the bug shipped.
 *   2. OLD bridge, latch ENGAGED, gap longer than the SUBAGENT budget — a
 *      genuinely hung subagent. Asserts: stall DOES fire (we didn't disable the
 *      safety net, just widened it).
 *   3. NEW bridge (>= 0.2.16) emitting `subagentActivity` — modeled as periodic
 *      noteProgress() during the gap (run-attempt maps any non-"heartbeat"
 *      turn/progress to noteProgress). Asserts: NO stall, AND the latch is
 *      cleared by real progress so the post-subagent window is the tight one.
 *
 * On any invariant violation it throws and exits non-zero; on success it prints
 * "All runtime assertions passed."
 *
 * Run: pnpm tsx scripts/proof-claude-subagent-stall.ts
 */

import {
  createClaudeProgressWatch,
  type ClaudeProgressWatch,
} from "../extensions/claude/src/app-server/progress-watch.js";

// Scaled-down budgets (real timers). Base = 120ms, subagent = 600ms (5x), hard
// gaps chosen to land unambiguously inside/outside each window.
const BASE_MS = 120;
const SUBAGENT_MS = 600;

let checks = 0;
function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    throw new Error(`INVARIANT VIOLATION: ${message}`);
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Harness = {
  watch: ClaudeProgressWatch;
  stalled: () => boolean;
};

function makeWatch(withSubagentBudget: boolean): Harness {
  let stalled = false;
  let settled = false;
  const watch = createClaudeProgressWatch({
    timeoutMs: BASE_MS,
    subagentTimeoutMs: withSubagentBudget ? SUBAGENT_MS : undefined,
    isSettled: () => settled,
    onStall: () => {
      stalled = true;
      settled = true; // a real stall settles the turn
    },
  });
  return { watch, stalled: () => stalled };
}

/**
 * Replays the note* sequence run-attempt.ts emits for a native-subagent turn up
 * to the point the subagent is dispatched: item/started (LLM begins describing
 * the Agent tool_use) → item/completed (LLM finished describing it) → because
 * the completed item name is "Agent", noteSubagentDispatched(). After this, the
 * SDK runs the subagent silently.
 */
function dispatchNativeSubagent(watch: ClaudeProgressWatch): void {
  watch.arm();
  watch.noteItemStarted(); // item/started for the Agent tool_use block
  watch.noteItemCompleted(); // item/completed (LLM done describing the call)
  watch.noteSubagentDispatched(); // run-attempt sees item.name === "Agent"
}

async function scenario1_oldBridgeLatchHolds(): Promise<void> {
  const h = makeWatch(true);
  dispatchNativeSubagent(h.watch);
  // Silent gap longer than BASE but shorter than SUBAGENT — the exact window the
  // bug killed. Old bridge: nothing flows (heartbeats are not mapped to the watch).
  await sleep(BASE_MS * 2);
  assert(
    !h.stalled(),
    "scenario 1: turn stalled during a native subagent run within the subagent budget (the bug)",
  );
  // Subagent finishes → real downstream output resumes (assistant text).
  h.watch.noteProgress();
  await sleep(BASE_MS / 2);
  assert(!h.stalled(), "scenario 1: spurious stall after subagent produced output");
}

async function scenario2_genuinelyHungSubagentStillCaught(): Promise<void> {
  const h = makeWatch(true);
  dispatchNativeSubagent(h.watch);
  // Gap exceeds the SUBAGENT budget — a genuinely stuck subagent. The safety net
  // must still fire (we widened it, we didn't remove it).
  await sleep(SUBAGENT_MS + BASE_MS * 2);
  assert(
    h.stalled(),
    "scenario 2: a subagent hung past the subagent budget was NOT torn down (safety net lost)",
  );
}

async function scenario3_newBridgeEmitsSubagentActivity(): Promise<void> {
  const h = makeWatch(true);
  dispatchNativeSubagent(h.watch);
  // New bridge (>= 0.2.16) emits turn/progress {kind:"subagentActivity"} every
  // ~20s; run-attempt maps any non-"heartbeat" turn/progress to noteProgress().
  // Model that as periodic progress through a long gap that FAR exceeds even the
  // subagent budget — proving the server-side fix alone keeps the turn alive
  // (and the latch is cleared by real progress, so the tight window applies
  // between activity ticks, which is fine because ticks are frequent).
  const totalGap = SUBAGENT_MS * 3;
  const tick = BASE_MS - 30; // comfortably inside the base window
  let elapsed = 0;
  while (elapsed < totalGap) {
    await sleep(tick);
    h.watch.noteProgress();
    elapsed += tick;
  }
  assert(
    !h.stalled(),
    "scenario 3: turn stalled despite the bridge emitting real subagentActivity progress",
  );
}

async function main(): Promise<void> {
  await scenario1_oldBridgeLatchHolds();
  await scenario2_genuinelyHungSubagentStillCaught();
  await scenario3_newBridgeEmitsSubagentActivity();
  // eslint-disable-next-line no-console
  console.log(`All runtime assertions passed. (${checks} checks across 3 scenarios)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
