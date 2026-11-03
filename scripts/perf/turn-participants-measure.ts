// Run: node --import ./scripts/tsx.mjs scripts/perf/turn-participants-measure.ts
// Add --allocation for a separate sampled-allocation pass. To compare a saved owner
// revision, add --owner-file /absolute/path/session-controller.tool-authority.ts.
// Measures 100,000 create/resolve/close operations after 10,000 warmup operations;
// host-issued authority checks and the shared command-target freeze stay enabled.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { allocation: { type: "boolean" }, "owner-file": { type: "string" } },
});
const owner = new URL("../../src/sessions/session-controller.tool-authority.ts", import.meta.url);
if (values["owner-file"]) {
  const saved = pathToFileURL(values["owner-file"]);
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url === owner.href ? saved.href : url, context);
    },
  });
}
const { createReplyTurnParticipants } =
  await import("../../src/sessions/session-controller.tool-authority.js");
const { createAdmittedRunOperatorAuthority } =
  await import("../../src/agents/admitted-run-context.js");
const authority = createAdmittedRunOperatorAuthority({
  profileId: "synthetic-profile",
  scopes: ["operator.admin"],
  assertCurrent() {},
});
const fixture = {
  operatorAuthority: authority,
  senderId: "synthetic-sender",
  senderName: "Synthetic Person",
  requesterOrigin: { operatorProfileId: "synthetic-profile", sessionKey: "agent:main:synthetic" },
  gatewayUiCommandTarget: { connId: "synthetic-client", profileId: "synthetic-profile" },
};
let last: ReturnType<ReturnType<typeof createReplyTurnParticipants>["resolve"]>;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const participants = createReplyTurnParticipants(fixture);
    last = participants.resolve();
    participants.close();
  }
}
run(10_000);
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpuStart = process.cpuUsage();
const start = performance.now();
run(100_000);
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  sampledBytes = bytes(profile.head);
  inspector.disconnect();
}
assert.equal(last?.profileId, "synthetic-profile");
console.log(
  JSON.stringify({
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    operations: 100_000,
    wallMs,
    cpuUsPerOperation: (cpu.user + cpu.system) / 100_000,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / 100_000,
    load: loadavg(),
  }),
);
