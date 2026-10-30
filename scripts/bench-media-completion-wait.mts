/** Counts-only owner workload: node --import ./scripts/tsx.mjs scripts/bench-media-completion-wait.mts */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { parseArgs } from "node:util";
import { waitForCompletionRequiredAsyncTasks } from "../src/agents/embedded-agent-runner/run/attempt-async-tasks.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  updateMediaGenerationOperation,
} from "../src/agents/media-generation-activity.js";

const { values } = parseArgs({
  options: { samples: { type: "string", default: "5" } },
});
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("--samples must be a positive integer");
}

const results: Array<{ sample: number; deadlineReads: number; mainTimeouts: number }> = [];
for (let sample = 1; sample <= samples; sample++) {
  const runId = `pollwaits-synthetic-media-${sample}`;
  const sessionKey = `agent:main:cron:pollwaits-bench:run:${sample}`;
  createMediaGenerationOperation({
    taskId: runId,
    runId,
    taskKind: "image_generation",
    requesterSessionKey: sessionKey,
    status: "running",
  });
  let deadlineReads = 0;
  let mainTimeouts = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === "Timeout") {
        mainTimeouts++;
      }
    },
  });
  hook.enable();
  const completion = setTimeout(() => {
    updateMediaGenerationOperation(runId, { status: "succeeded", endedAt: Date.now() });
    clearGeneratedMediaTaskActivity(runId);
  }, 1_250);
  try {
    const result = await waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => [],
      sessionKey,
      getDeadlineAtMs: () => {
        deadlineReads++;
        return undefined;
      },
      onDeadlineChanged: () => () => {},
    });
    assert.deepEqual(result.timedOutRunIds, []);
  } finally {
    hook.disable();
    clearTimeout(completion);
  }
  results.push({ sample, deadlineReads, mainTimeouts });
}

console.log(
  JSON.stringify({ workload: "media-completion-wait", completionAfterMs: 1_250, results }),
);
