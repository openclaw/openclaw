// Isolated owner measurement; never point --state-dir at operator state.
// node --import ./scripts/tsx.mjs scripts/perf/gateway-owner-read-measure.mts --state-dir <synthetic-state> [--subject <module>] [--samples 2]
// Compare two baseline controls and five serial baseline/candidate pairs. The RPC flow
// is measured separately: a fresh owner read must create zero private DB images.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    subject: { type: "string", default: "src/infra/gateway-owner-lease.ts" },
    export: { type: "string", default: "readGatewayOwnerLease" },
    samples: { type: "string", default: "1" },
  },
});
assert(values["state-dir"]);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
process.env.OPENCLAW_STATE_DIR = path.resolve(values["state-dir"]);
const snapshotSpawns: string[] = [];
const observer = {
  apply(
    target: typeof childProcess.spawn | typeof childProcess.spawnSync,
    receiver: unknown,
    args: unknown[],
  ) {
    if (JSON.stringify(args.slice(0, 2)).includes("readonly-child")) {
      snapshotSpawns.push(new Error("readonly-child spawn").stack ?? "unknown stack");
    }
    return Reflect.apply(target, receiver, args);
  },
};
childProcess.spawn = new Proxy<typeof childProcess.spawn>(childProcess.spawn, observer);
childProcess.spawnSync = new Proxy<typeof childProcess.spawnSync>(childProcess.spawnSync, observer);
syncBuiltinESMExports();
const subjectSha256 = createHash("sha256").update(fs.readFileSync(values.subject)).digest("hex");
const subject = await import(pathToFileURL(path.resolve(values.subject)).href);
const readGatewayOwnerLease = subject[values.export];
assert.equal(typeof readGatewayOwnerLease, "function");
const profiler = new Session();
profiler.connect();
for (let sample = 0; sample < samples; sample++) {
  snapshotSpawns.length = 0;
  const memoryBefore = process.memoryUsage();
  await new Promise<void>((resolve, reject) => {
    profiler.post(
      "HeapProfiler.startSampling",
      {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const lease = readGatewayOwnerLease({ current: true });
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const bytes = await new Promise<number>((resolve, reject) => {
    profiler.post("HeapProfiler.stopSampling", (error, result) =>
      error
        ? reject(error)
        : resolve(result.profile.samples.reduce((total, entry) => total + entry.size, 0)),
    );
  });
  console.log(
    JSON.stringify({
      sample,
      subjectSha256,
      ms,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledV8Bytes: bytes,
      memory: process.memoryUsage(),
      memoryBefore,
      snapshotSpawns,
      hostLoad: loadavg(),
      ownerState: lease?.state ?? "absent",
    }),
  );
}
profiler.disconnect();
