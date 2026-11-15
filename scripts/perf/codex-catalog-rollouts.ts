/**
 * Bounded Codex rollout reader: mixed 8 KiB / 512 KiB synthetic files, repeated
 * changed-file reads (unchanged fingerprints are skipped upstream). Fixture I/O,
 * module loading, and warmup are outside measurement. No Gateway/Team access.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-catalog-rollouts.ts --mode timing
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-catalog-rollouts.ts --mode allocation
 * Add --module .local/base-rollouts.ts to load a git-show snapshot at its original
 * module URL, preserving relative imports. Alternate base/candidate launch order;
 * compare untraced timing separately from sampled allocation (including dead
 * objects). Defaults: 32 files x 32 passes = 1,024 reader calls per invocation.
 * --files and --passes bound run cost; --mode counts instruments one pass only.
 * This measures the reader owner, not whole-Gateway latency or throughput.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    mode: { type: "string", default: "timing" },
    files: { type: "string", default: "32" },
    passes: { type: "string", default: "32" },
  },
});
const fileCount = Number(values.files);
const passes = values.mode === "counts" ? 1 : Number(values.passes);
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(Number.isSafeInteger(fileCount) && fileCount > 0);
assert(Number.isSafeInteger(passes) && passes > 0);
const ownerUrl = new URL("../../extensions/codex/src/session-catalog-rollouts.ts", import.meta.url);
const source = readFileSync(values.module ?? ownerUrl, "utf8");
let loaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { readCodexCatalogRollout } =
  await import("../../extensions/codex/src/session-catalog-rollouts.js");
hooks.deregister();
assert(loaded, "The selected owner must be loaded");

const timestamp = "2026-10-01T00:00:00.000Z";
const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp, type, payload })}\n`;
const event = (type: string, payload: Record<string, unknown>) =>
  line("event_msg", { type, ...payload });
const filler =
  line("response_item", {
    type: "function_call_output",
    call_id: "tool",
    output: "output\n".repeat(512),
  }) +
  event("token_count", {
    info: { total_token_usage: { input_tokens: 1000, output_tokens: 100 } },
  }) +
  event("agent_message", { message: "Progress update. ".repeat(128) });
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/codex-rollout-measure-"));
const files: string[] = [];
let corpusBytes = 0;
let windowBytesPerPass = 0;
const inspector = new Session();
const originalParse = JSON.parse;
try {
  for (let index = 0; index < fileCount; index++) {
    const prefix =
      line("session_meta", {
        id: `thread-${index}`,
        timestamp,
        source: "cli",
        cwd: "/synthetic/project",
        session_id: "synthetic-session",
      }) + event("user_message", { message: "Synthetic catalog preview" });
    const suffix =
      event("turn_started", { started_at: 1790812860 }) +
      event("thread_settings_applied", { thread_settings: { cwd: "/synthetic/moved" } });
    const targetBytes = index % 2 === 0 ? 8 * 1024 : 512 * 1024;
    const contents = prefix + filler.repeat(Math.ceil(targetBytes / filler.length)) + suffix;
    const file = path.join(root, `rollout-${index}.jsonl`);
    await fs.writeFile(file, contents);
    files.push(file);
    const bytes = Buffer.byteLength(contents);
    corpusBytes += bytes;
    windowBytesPerPass += Math.min(bytes, 256 * 1024);
    const row = await readCodexCatalogRollout(root, file);
    assert(row);
    assert.equal(row.id, `thread-${index}`);
    assert.equal(row.preview, "Synthetic catalog preview");
    assert.equal(row.cwd, "/synthetic/moved");
    assert.equal(row.recencyAt, 1790812860);
  }
  globalThis.gc?.();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let parseCalls = 0;
  if (values.mode === "counts") {
    JSON.parse = (...args) => {
      parseCalls++;
      return Reflect.apply(originalParse, JSON, args);
    };
  }
  const loadBefore = loadavg();
  const threadBefore = process.threadCpuUsage();
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  let rows = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (const file of files) {
      rows += (await readCodexCatalogRollout(root, file)) ? 1 : 0;
    }
  }
  const elapsedMs = performance.now() - start;
  const thread = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  JSON.parse = originalParse;
  assert.equal(rows, fileCount * passes);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      fileCount,
      passes,
      iterations: rows,
      corpusBytes,
      windowBytesPerPass,
      parseCalls: values.mode === "counts" ? parseCalls : undefined,
      elapsedMs: values.mode === "timing" ? elapsedMs : undefined,
      mainThreadCpuMs: values.mode === "timing" ? (thread.user + thread.system) / 1000 : undefined,
      processCpuMs: values.mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
      sampledBytes,
      bytesPerRead: sampledBytes === undefined ? undefined : sampledBytes / rows,
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  JSON.parse = originalParse;
  inspector.disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
