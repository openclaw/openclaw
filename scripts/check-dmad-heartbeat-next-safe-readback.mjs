#!/usr/bin/env node

import assert from "node:assert/strict";
import { runHeartbeatNextSafeReadbackCli } from "./dmad-heartbeat-next-safe-readback.mjs";

const machineLine =
  "nextSafe=controlled_task_runner_check;dmadGate=timeout-smoke:gate:ultra:verify:ultra:full;dmadPublish=verified;readOnly=true";

async function runPlainReadback({ now, freshnessNow = now, maxAgeMs }) {
  let output = "";
  const report = await runHeartbeatNextSafeReadbackCli({
    argv: ["--no-write-state"],
    repoRoot: "repo",
    runNextSafe: async () => ({
      exitCode: 0,
      stdout: `machine_line=${machineLine}\n`,
      stderr: "",
    }),
    writeReport: async () => {
      throw new Error("check must not write latest artifact");
    },
    stdout: {
      write(chunk) {
        output += chunk;
        return true;
      },
    },
    now,
    freshnessNow,
    maxAgeMs,
  });
  return { output, report };
}

const ready = await runPlainReadback({
  now: new Date("2026-05-25T00:00:00.000Z"),
});
assert.equal(ready.report.status, "ready");
assert.equal(ready.report.automationReadPoint.dispatchable, true);
assert.match(ready.output, /^next_safe=controlled_task_runner_check$/m);
assert.match(ready.output, /^dispatchable=true$/m);
assert.doesNotMatch(ready.output, /^dispatch_blocked_reason=/m);

const stale = await runPlainReadback({
  now: new Date("2026-05-25T00:00:00.000Z"),
  freshnessNow: new Date("2026-05-25T00:00:02.000Z"),
  maxAgeMs: 1000,
});
assert.equal(stale.report.status, "blocked");
assert.equal(stale.report.automationReadPoint.dispatchable, false);
assert.match(stale.output, /^next_safe=controlled_task_runner_check$/m);
assert.match(stale.output, /^dispatchable=false$/m);
assert.match(stale.output, /^blocked_reason=generatedAt_ageMs=2000_exceeds_1000$/m);
assert.match(stale.output, /^dispatch_blocked_reason=generatedAt_ageMs=2000_exceeds_1000$/m);

console.log("[check-dmad-heartbeat-next-safe-readback] PASS");
