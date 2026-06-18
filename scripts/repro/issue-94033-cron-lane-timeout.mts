#!/usr/bin/env node
// Standalone real-environment proof for #94033.
//
// Reproduces the lane-task timeout sliding window from
// `src/process/command-queue.ts`. A task that takes longer than the
// configured `taskTimeoutMs` without reporting progress triggers
// `CommandLaneTaskTimeoutError`.
//
// With the fix (heartbeat helper applied), `noteProgress` is invoked
// periodically while the task is in flight, so the sliding window
// stays fresh and the task completes successfully.
//
// Without the fix, the task exceeds `taskTimeoutMs` and the timeout
// fires.
//
// Run: node --import tsx scripts/repro/issue-94033-cron-lane-timeout.mts
import assert from "node:assert/strict";
import {
  CommandLaneTaskTimeoutError,
  enqueueCommandInLane,
  resetCommandLane,
} from "../../src/process/command-queue.ts";
import { startLaneTaskProgressHeartbeat } from "../../src/agents/embedded-agent-runner/lane-heartbeat.ts";

const LANE = "repro-cron-94033";
const TASK_TIMEOUT_MS = 600; // Short timeout for fast reproduction
const HEARTBEAT_INTERVAL_MS = 100; // < grace window, similar pattern to real prod
const TASK_DURATION_MS = 1_500; // > TASK_TIMEOUT_MS, would trigger timeout without heartbeat

async function runScenario({
  withHeartbeat,
  label,
}: {
  withHeartbeat: boolean;
  label: string;
}) {
  resetCommandLane(LANE);
  let progressNotes = 0;
  // The progress-at timestamp mirrors the production pattern:
  // `let laneTaskProgressAtMs = Date.now(); noteProgress = () => { laneTaskProgressAtMs = Date.now() }`
  // The lane-task timeout callback reads this same closure variable.
  let lastProgressAtMs = Date.now();
  const noteProgress = () => {
    lastProgressAtMs = Date.now();
    progressNotes += 1;
  };
  const taskPromise = enqueueCommandInLane(
    LANE,
    async () => {
      const heartbeat = withHeartbeat
        ? startLaneTaskProgressHeartbeat(noteProgress, HEARTBEAT_INTERVAL_MS)
        : undefined;
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TASK_DURATION_MS);
        });
        return "completed";
      } finally {
        heartbeat?.stop();
      }
    },
    {
      taskTimeoutMs: TASK_TIMEOUT_MS,
      taskTimeoutProgressAtMs: () => lastProgressAtMs,
    },
  );

  const started = Date.now();
  let outcome: "completed" | "timed-out";
  try {
    await taskPromise;
    outcome = "completed";
  } catch (err) {
    if (err instanceof CommandLaneTaskTimeoutError) {
      outcome = "timed-out";
    } else {
      throw err;
    }
  }
  const elapsedMs = Math.round(Date.now() - started);

  console.log(`[${label}] outcome=${outcome} elapsedMs=${elapsedMs} noteProgressCalls=${progressNotes}`);
  return { outcome, elapsedMs, progressNotes };
}

console.log("=== Reproduction for issue #94033 ===");
console.log(`Lane: ${LANE}`);
console.log(`Configured taskTimeoutMs: ${TASK_TIMEOUT_MS}`);
console.log(`Task runs for: ${TASK_DURATION_MS}ms (longer than timeout)`);
console.log("");

const without = await runScenario({ withHeartbeat: false, label: "without-heartbeat" });
console.log("");
const withFix = await runScenario({ withHeartbeat: true, label: "with-heartbeat " });

console.log("");
console.log("=== Results ===");
console.log(
  `Without heartbeat (pre-fix): timed-out after ${without.elapsedMs}ms (timeout fired as expected)`,
);
console.log(
  `With heartbeat    (post-fix): ${withFix.outcome} after ${withFix.elapsedMs}ms (noteProgress called ${withFix.progressNotes} times)`,
);

assert.equal(without.outcome, "timed-out", "pre-fix scenario should time out");
assert.equal(withFix.outcome, "completed", "post-fix scenario should complete");
assert.ok(
  withFix.progressNotes >= 10,
  `heartbeat should fire many times during ${TASK_DURATION_MS}ms at ${HEARTBEAT_INTERVAL_MS}ms interval, got ${withFix.progressNotes}`,
);

console.log("");
console.log("PASS: heartbeat keeps the lane-task sliding window alive during long-running work.");