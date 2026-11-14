/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-history-param-validation-measure.mjs
 * Measures only real protocol-validation segments, NOT Gateway latency or total allocation.
 * Before: validate the public request and its already-admitted history parameters again.
 * After: validate the public request once. Fixtures and normalization are outside both arms.
 * Five counterbalanced pairs use untraced thread CPU; separate allocation passes retain
 * samples of collected objects. Synthetic fixtures rotate through 10,000 session keys.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import {
  validateChatHistoryParams,
  validateChatStartupParams,
} from "../../packages/gateway-protocol/src/validators/conversations.ts";
import { validateSessionsMessagesSubscribeParams } from "../../packages/gateway-protocol/src/validators/sessions.ts";

assert(global.gc, "Run with --expose-gc");
const operations = 10_000;
const fixtures = Array.from({ length: operations }, (_, index) => {
  const sessionKey = `agent:main:session:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const page = { limit: 200, maxBytes: 1_048_576, toolResultMaxChars: 8000 };
  const initialHistory = {
    ...page,
    knownState: { pendingInputs: "pending-v1", sessionInfo: "session-v1", commands: "commands-v1" },
    inputRunIds: [`run-${index}`],
  };
  const history = { sessionKey, agentId: "main", ...initialHistory };
  return {
    direct: { outer: history, history },
    short: {
      outer: { shortId: index.toString(16).padStart(8, "0"), agentId: "main", ...page },
      history: { sessionKey, agentId: "main", ...page },
    },
    subscription: { outer: { key: sessionKey, agentId: "main", initialHistory }, history },
  };
});
const workloads = [
  ["direct", validateChatStartupParams],
  ["short", validateChatStartupParams],
  ["subscription", validateSessionsMessagesSubscribeParams],
];
function run(name, validate, before, count = operations) {
  let accepted = 0;
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index][name];
    if (validate(fixture.outer) && (!before || validateChatHistoryParams(fixture.history))) {
      accepted++;
    }
  }
  assert.equal(accepted, count);
}
function sampledBytes(node) {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const rows = [];
for (const [name, validate] of workloads) {
  run(name, validate, true);
  run(name, validate, false);
  for (const mode of ["timing", "allocation"]) {
    for (let pair = 0; pair < 5; pair++) {
      for (const before of pair % 2 === 0 ? [true, false] : [false, true]) {
        global.gc();
        const hostLoad = loadavg();
        let inspector;
        if (mode === "allocation") {
          inspector = new Session();
          inspector.connect();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpuStart = process.threadCpuUsage();
        const start = performance.now();
        run(name, validate, before);
        const elapsedMs = performance.now() - start;
        const cpu = process.threadCpuUsage(cpuStart);
        let bytes;
        if (inspector) {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          bytes = sampledBytes(profile.head);
          inspector.disconnect();
        }
        rows.push({
          workload: name,
          mode,
          pair: pair + 1,
          arm: before ? "before" : "after",
          operations,
          hostLoad,
          ...(mode === "timing"
            ? { elapsedMs, threadCpuUs: cpu.user + cpu.system }
            : { sampledBytes: bytes }),
        });
      }
    }
  }
}
console.log(
  JSON.stringify(
    { node: process.version, scope: "protocol validation segment only", rows },
    null,
    2,
  ),
);
