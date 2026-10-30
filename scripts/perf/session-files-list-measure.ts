/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-files-list-measure.ts
 * --state-dir "$PWD/.local/files-list" [--seed] [--source /absolute/adjacent-owner-copy.ts]
 * [--base-source /absolute/adjacent-base-owner-copy.ts]
 * [--iterations 400] [--samples 1] [--mode timing|allocation] [--case root|nested|search]
 * Seed once. --base-source alternates AB/BA against the SAME fixture; --samples 5 measures
 * 2,000 operations per arm by default. All responseHash values must match across both arms.
 * Acceptance: identical output, fewer filesystem operations, and lower CPU/allocation per
 * operation without a reproducible wall-time regression. Timing and allocation are separate.
 * This owner benchmark browses 80 root entries above 2,000 files, including ignored output;
 * it does not measure Gateway admission, session state, WebSocket clients, or RPC latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    source: { type: "string" },
    "base-source": { type: "string" },
    iterations: { type: "string", default: "400" },
    samples: { type: "string", default: "1" },
    mode: { type: "string", default: "timing" },
    case: { type: "string", default: "root" },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(values.mode === "timing" || values.mode === "allocation", "invalid --mode");
assert(["root", "nested", "search"].includes(values.case), "invalid --case");
const integer = (name: "iterations" | "samples") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const samples = integer("samples");
const root = path.resolve(values["state-dir"], "fixture");
if (values.seed) {
  await mkdir(path.dirname(root), { recursive: true });
  // Exclusive creation prevents a rerun from overwriting an existing fixture or user data.
  await mkdir(root);
  await writeFile(path.join(root, ".git"), "gitdir: synthetic-metadata\n", { flag: "wx" });
  await writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n", { flag: "wx" });
  for (let index = 0; index < 56; index++) {
    await writeFile(
      path.join(root, `file-${index.toString().padStart(2, "0")}.ts`),
      "export {};\n",
      {
        flag: "wx",
      },
    );
  }
  const directories = [
    ...Array.from({ length: 20 }, (_, index) => `dir-${index.toString().padStart(2, "0")}`),
    "node_modules",
    "dist",
  ];
  for (const directory of directories) {
    await mkdir(path.join(root, directory));
    const count = directory.startsWith("dir-") ? 80 : 200;
    for (let index = 0; index < count; index++) {
      await writeFile(path.join(root, directory, `item-${index}.ts`), "export const value = 1;\n", {
        flag: "wx",
      });
    }
  }
}
const source = values.source
  ? pathToFileURL(path.resolve(values.source))
  : new URL("../../src/gateway/server-methods/workspace-files.ts", import.meta.url);
const { listSessionWorkspaceFiles } = (await import(
  source.href
)) as typeof import("../../src/gateway/server-methods/workspace-files.js");
const arms = [{ arm: "candidate", list: listSessionWorkspaceFiles }];
if (values["base-source"]) {
  const base = (await import(
    pathToFileURL(path.resolve(values["base-source"])).href
  )) as typeof import("../../src/gateway/server-methods/workspace-files.js");
  arms.unshift({ arm: "base", list: base.listSessionWorkspaceFiles });
}
const request = {
  root,
  fileRoot: root,
  diffCwd: root,
  files: [],
  ...(values.case === "nested" ? { path: "dir-00" } : {}),
  ...(values.case === "search" ? { search: "item-7" } : {}),
};
let result = await arms[0]!.list(request);
assert(result.browser, "fixture must exist and be browsable");
const digest = () => createHash("sha256").update(JSON.stringify(result)).digest("hex");
const responseHash = digest();
async function run(list: typeof listSessionWorkspaceFiles, count: number) {
  for (let index = 0; index < count; index++) {
    result = await list(request);
  }
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
for (const { list } of arms) {
  await run(list, 10);
  assert.equal(digest(), responseHash, "arm response differs during warmup");
}
for (let sample = 0; sample < samples; sample++) {
  for (const { arm, list } of sample % 2 === 0 ? arms : arms.toReversed()) {
    globalThis.gc?.();
    await setImmediate();
    const hostLoad = loadavg();
    const pauses: number[] = [];
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        pauses.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const inspector = values.mode === "allocation" ? new Session() : undefined;
    inspector?.connect();
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpuStart = process.cpuUsage();
    const threadStart = process.threadCpuUsage();
    const start = performance.now();
    await run(list, iterations);
    const elapsedMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(threadStart);
    const cpu = process.cpuUsage(cpuStart);
    const allocation = await inspector?.post("HeapProfiler.stopSampling");
    inspector?.disconnect();
    await setImmediate();
    for (const entry of observer.takeRecords()) {
      pauses.push(entry.duration);
    }
    observer.disconnect();
    assert.equal(digest(), responseHash, "fixture response changed during measurement");
    console.log(
      JSON.stringify({
        arm,
        mode: values.mode,
        case: values.case,
        sample,
        operations: iterations,
        responseHash,
        hostLoad,
        hostLoadAfter: loadavg(),
        processCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
        threadCpuUsPerOperation: (threadCpu.user + threadCpu.system) / iterations,
        wallUsPerOperation: (elapsedMs * 1_000) / iterations,
        gcMsPerOperation: pauses.reduce((sum, pause) => sum + pause, 0) / iterations,
        gcCount: pauses.length,
        gcMaxMs: Math.max(0, ...pauses),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        ...(allocation
          ? { sampledBytesPerOperation: allocated(allocation.profile.head) / iterations }
          : {}),
      }),
    );
  }
}
