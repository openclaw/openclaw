/**
 * Native/CLI avatar-list owner benchmark: eight synthetic 64 KiB local avatars,
 * four concurrent readers, warm revisions. Includes real file-reader worker tasks;
 * main-thread CPU/allocation excludes worker CPU/allocation and process startup.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/avatar-inline-measure.ts
 *   --iterations 2000 [--allocations] [--owner /absolute/saved/identity-avatar-file.ts]
 * Save the baseline owner before editing; --owner loads it through this import graph.
 * Alternate base/candidate order; timing and sampled-allocation passes are separate.
 * Acceptance: identical output, fewer base64 encodings and lower main-thread CPU/
 * allocation. This does not measure browser/Gateway latency or reduce worker tasks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "iterations",
});
const ownerUrl = new URL("../../src/agents/identity-avatar-file.ts", import.meta.url).href;
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl) {
        return nextLoad(url, context);
      }
      replaced = true;
      const result = nextLoad(replacement, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { resolveAgentAvatarUrlFromSource } =
  await import("../../src/agents/identity-avatar-file.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
assert(!values.owner || replaced, "Baseline owner was not loaded");
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/avatar-inline-"));
const cfg = { agents: { entries: { main: { workspace: root } } } };
const avatars = Array.from({ length: 8 }, (_, index) => {
  const source = `${index}.png`;
  const body = Buffer.alloc(64 * 1024, index + 1);
  writeFileSync(path.join(root, source), body);
  return { source, expected: `data:image/png;base64,${body.toString("base64")}` };
});
async function run(count: number) {
  let chars = 0;
  for (let offset = 0; offset < count; offset += 4) {
    const results = await Promise.all(
      Array.from({ length: Math.min(4, count - offset) }, (_, client) => {
        const avatar = avatars[(offset + client) % avatars.length]!;
        return resolveAgentAvatarUrlFromSource(cfg, "main", avatar.source);
      }),
    );
    for (const [client, result] of results.entries()) {
      const avatar = avatars[(offset + client) % avatars.length]!;
      assert.equal(result, avatar.expected);
      chars += result.length;
    }
  }
  return chars;
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const inspector = new Session();
try {
  await run(64);
  globalThis.gc?.();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const chars = await run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocations
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      owner: values.owner ?? ownerUrl,
      iterations,
      chars,
      cpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  await drainGlobalSingletonLifecycleState();
  rmSync(root, { recursive: true, force: true });
}
