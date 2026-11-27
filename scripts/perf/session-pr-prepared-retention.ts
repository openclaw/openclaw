/**
 * Distinct retired-session churn through the production PR subscription owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-pr-prepared-retention.ts
 * Add --owner-file <baseline.ts> for paired runs, --allocation for separate sampling.
 * No GitHub or SQLite I/O: source-less targets exercise prepared-cell retirement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { ControlUiSessionPrTarget } from "../../src/gateway/control-ui-session-pr-read.js";
import { sessionChanges } from "../../src/sessions/session-row-changes.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";
import { collectForRetentionCheck } from "../../src/test-utils/retention.js";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL(
  "../../src/gateway/control-ui-session-pr-prepared-read.ts",
  import.meta.url,
);
const source = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
let replaced = false;
const hooks = values["owner-file"]
  ? registerHooks({
      load(url, context, next) {
        if (url !== ownerUrl.href) {
          return next(url, context);
        }
        replaced = true;
        return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
      },
    })
  : undefined;
const { createControlUiSessionPullRequestSubscriptions } =
  await import("../../src/gateway/control-ui-session-pr-subscriptions.js");
hooks?.deregister();
assert(!values["owner-file"] || replaced, "Baseline owner was not loaded");
const scheduler = createTestGatewayScheduler();
const owner = createControlUiSessionPullRequestSubscriptions({
  scheduler,
  prepareRead: async () => undefined,
  broadcastToConnIds: () => {},
});
function run(start: number, count: number) {
  for (let index = start; index < start + count; index++) {
    const bytes = Buffer.alloc(4096, 97 + (index % 26));
    bytes.write(`synthetic-repository-${index}:`);
    const target: ControlUiSessionPrTarget = {
      params: { agentId: "main", sessionKey: `agent:main:retired-${index}` },
      identity: bytes.toString("ascii"),
      readSource: { agentId: "main", path: "/synthetic/agent.sqlite" },
      source: null,
    };
    assert.equal(owner.readPrepared(target)?.status, "ready");
    sessionChanges.emit({ ...target.params, facts: { kind: "removed" } });
  }
}
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
}
try {
  run(0, 256);
  await collectForRetentionCheck("prepared-pr-warm", 4);
  const before = process.memoryUsage();
  const results = [];
  for (let batch = 0; batch < 6; batch++) {
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    run(256 + batch * 4000, 4000);
    const wallMs = performance.now() - start;
    const cpu = process.threadCpuUsage(cpuStart);
    let allocatedBytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    await collectForRetentionCheck("prepared-pr-retired", 4);
    results.push({
      items: (batch + 1) * 4000,
      heapUsed: process.memoryUsage().heapUsed,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes,
      load: loadavg(),
    });
  }
  await owner.stop();
  await collectForRetentionCheck("prepared-pr-stopped", 4);
  console.log(
    JSON.stringify({
      node: process.version,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      allocation: values.allocation,
      identityBytes: 4096,
      before,
      results,
      afterStop: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  await owner.stop();
  await scheduler.stop();
}
