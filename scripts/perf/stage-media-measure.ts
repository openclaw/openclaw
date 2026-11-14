/**
 * Synthetic stageSandboxMedia owner benchmark, not a Gateway/load test.
 * Run identical tooling against captured base/candidate owners, interleaving arms:
 * node --import ./scripts/tsx.mjs scripts/perf/stage-media-measure.ts \
 *   --state-dir "$PWD/.local/stage-base-1" --output "$PWD/.local/stage-base-1.json" \
 *   --owner-dir "$PWD/.local/base-source" --bytes 33554432 --iterations 100
 * Allocation workload: --bytes 65536 --iterations 1000 --allocations, separately
 * from timing passes. --files defaults to 1; ten warmup operations are excluded.
 * --owner-dir contains src/auto-reply/reply/stage-sandbox-media.ts; its imports
 * retain their original URL. Receipts record the exact source hash and load count.
 * A caller-owned synthetic workspace skips provisioning and baseline capture.
 * Latency and CPU bracket staging only. Allocation, GC and event-loop metrics
 * include per-operation checks and cleanup, but exclude setup/byte verification.
 * Warmup verifies every file's bytes and independent source/destination writes.
 * Fresh state is mandatory. Source and workspace share its filesystem. Acceptance:
 * identical bytes, lower staging CPU/allocation or latency without material harm;
 * report paired host load, sample counts and maxima. No model calls or live state.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { RuntimeMsgContext } from "../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "1000" },
    bytes: { type: "string", default: "65536" },
    files: { type: "string", default: "1" },
    allocations: { type: "boolean", default: false },
    "owner-dir": { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const integer = (name: "iterations" | "bytes" | "files", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback });
const iterations = integer("iterations", 1000);
const bytes = integer("bytes", 65536);
const files = integer("files", 1);
assert(bytes <= 50 * 1024 * 1024, "--bytes must fit the default 50 MiB staging limit");
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output ?? path.join(root, "result.json"));
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root); // Refuse existing state; never adopt an operator's directory.
await fs.mkdir(path.dirname(output), { recursive: true });
process.env.TMPDIR = root;
process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_HOME = process.env.HOME;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state", "openclaw.json");
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
await fs.mkdir(process.env.HOME);

const ownerPath = "src/auto-reply/reply/stage-sandbox-media.ts";
const ownerUrl = new URL(`../../${ownerPath}`, import.meta.url).href;
const source = readFileSync(
  values["owner-dir"] ? path.join(path.resolve(values["owner-dir"]), ownerPath) : new URL(ownerUrl),
  "utf8",
);
const ownerReceipt = {
  path: ownerPath,
  sha256: createHash("sha256").update(source).digest("hex"),
  loads: 0,
  overlay: Boolean(values["owner-dir"]),
};
const code = values["owner-dir"]
  ? (await import("esbuild")).transformSync(source, {
      loader: "ts",
      format: "esm",
      target: "esnext",
      sourcefile: ownerPath,
    }).code
  : undefined;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === ownerUrl) {
      ownerReceipt.loads++;
      if (code !== undefined) {
        loaded.source = code;
      }
    }
    return loaded;
  },
});

const { stageSandboxMedia } = await import("../../src/auto-reply/reply/stage-sandbox-media.js");
assert.equal(ownerReceipt.loads, 1, "the measured owner must load exactly once");
const workspaceDir = path.join(root, "workspace");
const inboundDir = path.join(process.env.OPENCLAW_STATE_DIR, "media", "inbound");
await fs.mkdir(workspaceDir);
await fs.mkdir(inboundDir, { recursive: true });
const payload = Buffer.alloc(bytes, 0x5a);
const sources = Array.from({ length: files }, (_, index) =>
  path.join(inboundDir, `synthetic-${index}.bin`),
);
for (const sourcePath of sources) {
  await fs.writeFile(sourcePath, payload);
}
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { main: { workspace: workspaceDir } },
    defaults: { workspace: workspaceDir, sandbox: { mode: "off" } },
  },
};
const controller = new AbortController();
const preparedWorkspace = {
  workspace: { workspaceDir },
  assertCurrent: () => controller.signal.throwIfAborted(),
  [Symbol.dispose]() {},
};
const latencies: number[] = [];
let threadCpuUs = 0;
let processCpuUs = 0;
async function writeByte(file: string, value: number) {
  await using handle = await fs.open(file, "r+");
  await handle.write(Buffer.from([value]), 0, 1, 0);
}
async function firstByte(file: string) {
  await using handle = await fs.open(file, "r");
  const buffer = Buffer.alloc(1);
  await handle.read(buffer, 0, 1, 0);
  return buffer[0];
}
async function run(measured: boolean, verify: boolean) {
  const ctx: RuntimeMsgContext = {
    media: sources.map((sourcePath) => ({
      path: sourcePath,
      contentType: "application/octet-stream",
    })),
  };
  const threadBefore = process.threadCpuUsage();
  const processBefore = process.cpuUsage();
  const started = performance.now();
  const { staged } = await stageSandboxMedia({
    ctx,
    sessionCtx: ctx,
    cfg,
    agentId: "main",
    sessionKey: "agent:main:staging-measure",
    workspaceDir,
    preparedWorkspace,
    abortSignal: controller.signal,
  });
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(processBefore);
  if (measured) {
    latencies.push(elapsedMs);
    threadCpuUs += threadCpu.user + threadCpu.system;
    processCpuUs += cpu.user + cpu.system;
  }
  assert.equal(staged.size, files, "every attachment must stage");
  const directories = new Set<string>();
  try {
    for (const [index, relativePath] of staged) {
      const destination = path.resolve(workspaceDir, relativePath);
      assert(destination.startsWith(`${workspaceDir}${path.sep}`));
      assert(path.basename(path.dirname(destination)).startsWith("openclaw-staged-"));
      directories.add(path.dirname(destination));
      assert.equal(ctx.media?.[index]?.path, relativePath);
      if (verify) {
        const sourcePath = sources[index]!;
        assert.deepEqual(await fs.readFile(destination), payload);
        await writeByte(destination, 0x31);
        assert.equal(await firstByte(sourcePath), 0x5a, "staged edits must not alter the original");
        await writeByte(sourcePath, 0x32);
        assert.equal(
          await firstByte(destination),
          0x31,
          "original edits must not alter staged bytes",
        );
        await writeByte(sourcePath, 0x5a);
      }
    }
  } finally {
    for (const directory of directories) {
      await fs.rm(directory, { recursive: true });
    }
  }
}
for (let index = 0; index < 10; index++) {
  await run(false, index === 0);
}

const summarize = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
};
const gcByKind = new Map<number, number[]>();
const collections: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    collections.push(entry.duration);
    if (
      "detail" in entry &&
      typeof entry.detail === "object" &&
      entry.detail !== null &&
      "kind" in entry.detail &&
      typeof entry.detail.kind === "number"
    ) {
      const samples = gcByKind.get(entry.detail.kind) ?? [];
      samples.push(entry.duration);
      gcByKind.set(entry.detail.kind, samples);
    }
  }
});
const loop = monitorEventLoopDelay({ resolution: 1 });
const inspector = values.allocations ? new Session() : undefined;
inspector?.connect();
await inspector?.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const memoryBefore = process.memoryUsage();
const loadBefore = loadavg();
observer.observe({ entryTypes: ["gc"] });
loop.enable();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  await run(true, false);
}
const elapsedMs = performance.now() - started;
await immediate();
observer.disconnect();
loop.disable();
const memoryAfter = process.memoryUsage();
const loadAfter = loadavg();
let allocation;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const pending = [profile.head];
  let sampledBytes = 0;
  for (const node of pending) {
    sampledBytes += node.selfSize;
    pending.push(...node.children);
  }
  allocation = { bytes: sampledBytes, bytesPerOperation: sampledBytes / iterations };
  inspector.disconnect();
  await fs.writeFile(`${output}.heapprofile`, JSON.stringify(profile));
}
const summarizeGc = (samples: number[]) => {
  const total = samples.reduce((sum, value) => sum + value, 0);
  return { ...summarize(samples), total, perMinute: (total / elapsedMs) * 60000 };
};
const result = {
  kind: "stage-sandbox-media-owner",
  iterations,
  warmup: 10,
  files,
  bytesPerFile: bytes,
  allocations: values.allocations,
  ownerReceipt,
  elapsedMs,
  stageLatencyMs: summarize(latencies),
  mainThreadCpuMs: threadCpuUs / 1000,
  mainThreadCpuMsPerOperation: threadCpuUs / 1000 / iterations,
  processCpuMs: processCpuUs / 1000,
  processCpuMsPerOperation: processCpuUs / 1000 / iterations,
  allocation,
  gcMs: {
    ...summarizeGc(collections),
    byKind: Object.fromEntries(
      [...gcByKind].map(([kind, samples]) => [kind, summarizeGc(samples)]),
    ),
  },
  eventLoopMs: {
    count: loop.count,
    p50: loop.count ? loop.percentile(50) / 1e6 : null,
    p90: loop.count ? loop.percentile(90) / 1e6 : null,
    p95: loop.count ? loop.percentile(95) / 1e6 : null,
    p99: loop.count ? loop.percentile(99) / 1e6 : null,
    max: loop.count ? loop.max / 1e6 : null,
  },
  memory: { before: memoryBefore, after: memoryAfter },
  hostLoad: { before: loadBefore, after: loadAfter },
};
await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
await fs.rm(inboundDir, { recursive: true });
await fs.rm(workspaceDir, { recursive: true });
