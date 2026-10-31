/**
 * Device-request signer owner benchmark: 4,096 signatures over 16 synthetic device
 * seeds after 512 warmup requests. Run baseline/candidate in fresh processes with
 * counterbalanced launch order. Save identity.ts before editing and select it with
 * --owner-file; its imports still resolve from the production owner directory.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/reef-device-sign-measure.ts
 *   [--owner-file /absolute/path/baseline-identity.ts] [--allocation]
 *
 * Keep sampled-allocation passes separate from untraced CPU/latency measurements.
 * Output includes a signature digest so both revisions must produce equal bytes.
 */
import { createHash } from "node:crypto";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { allocation: { type: "boolean" }, "owner-file": { type: "string" } },
});
const owner = new URL("../../extensions/reef/protocol/identity.ts", import.meta.url);
if (values["owner-file"]) {
  const saved = pathToFileURL(values["owner-file"]);
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url === owner.href ? saved.href : url, context);
    },
  });
}
const { signDeviceRequest } = await import("../../extensions/reef/protocol/identity.js");
const keys = Array.from({ length: 16 }, (_, index) =>
  Buffer.alloc(32, index).toString("base64url"),
);
const requests = Array.from({ length: 64 }, (_, index) => ({
  method: index % 2 ? "POST" : "GET",
  path: index % 2 ? "/v1/mail/send" : "/v1/mail/ws",
  ts: 1_752_300_000 + index,
  bodySha256: index.toString(16).padStart(64, "0"),
}));
let last = "";
function run(count: number) {
  for (let index = 0; index < count; index++) {
    last = signDeviceRequest(requests[index % requests.length]!, keys[index % keys.length]!);
  }
}
run(512);
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
run(4096);
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
const digest = createHash("sha256");
for (const secret of keys) {
  for (const request of requests) {
    digest.update(signDeviceRequest(request, secret));
  }
}
console.log(
  JSON.stringify({
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    operations: 4096,
    wallMs,
    cpuUsPerOperation: (cpu.user + cpu.system) / 4096,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / 4096,
    signatureLength: last.length,
    digest: digest.digest("hex"),
    load: loadavg(),
  }),
);
