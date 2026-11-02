/**
 * Real plugin file-cache acquisition/retention benchmark; no filesystem mocks.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-cache-stat-facts.ts
 *   --output .local/stat-facts-base --iterations 4 [--allocations] [--snapshot]
 * Defaults: 17,032 entries across 40 plugin directories, alternating stat/lstat,
 * including directories and symlinks. Each iteration acquires a fresh inventory;
 * the final inventory stays reachable for forced-GC retention/count measurements.
 * Run each revision separately in AB/BA order. Allocation sampling is a separate
 * pass from timing. Fixture creation, warmup, verification, GC and snapshots are
 * outside measured work. --owner can load a saved baseline plugin-cache-files.ts.
 * Output is a new owned directory; fixture files are removed after measurement.
 * Acceptance: identical verified facts/checksum, no retained native Stats/Dirent,
 * lower retained heap; report CPU/allocation tradeoffs rather than hiding them.
 * This owner benchmark does not measure Gateway latency or inventory discovery.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    owner: { type: "string" },
    entries: { type: "string", default: "17032" },
    plugins: { type: "string", default: "40" },
    iterations: { type: "string", default: "4" },
    allocations: { type: "boolean", default: false },
    snapshot: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new directory");
const gc = globalThis.gc;
assert(gc, "Run with --expose-gc");
const integer = (name: "entries" | "plugins" | "iterations", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], fallback, min: 1, label: `--${name}` });
const entries = integer("entries", 17032);
const plugins = integer("plugins", 40);
const iterations = integer("iterations", 4);
assert(entries >= plugins * 3, "Each plugin needs at least three entries");
const ownerUrl = new URL("../../src/plugins/plugin-cache-files.ts", import.meta.url).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { pluginCacheStatSync, pluginCacheLstatSync, readPluginCacheDirectory } =
  await import("../../src/plugins/plugin-cache-files.js");
const { createPluginCache, withPluginCache } = await import("../../src/plugins/plugin-cache.js");
assert(!values.owner || wasOwnerReplaced(), "Baseline owner was not loaded");
const output = path.resolve(values.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
const fixture = path.join(output, "fixture");
fs.mkdirSync(fixture);
const payload = path.join(fixture, "payload");
fs.writeFileSync(payload, "synthetic plugin metadata\n", { mode: 0o600 });
const directories: string[] = [];
const inspector = new Session();

function acquire() {
  const cache = createPluginCache();
  withPluginCache(cache, () => {
    for (const directory of directories) {
      for (const entry of readPluginCacheDirectory(directory)) {
        const file = path.join(directory, entry.name);
        if (Number(entry.name.slice(6)) % 2) {
          pluginCacheLstatSync(file);
        } else {
          pluginCacheStatSync(file);
        }
      }
    }
  });
  return cache;
}

async function collect() {
  await nextTurn();
  gc!();
  gc!();
}

function verify(cache: ReturnType<typeof createPluginCache>) {
  let statRecords = 0;
  let directoryRecords = 0;
  let nativeStats = 0;
  let nativeDirents = 0;
  const checksum = createHash("sha256");
  for (const root of cache.roots.values()) {
    assert(root.directory?.ok);
    const actualEntries = new Map(
      fs.readdirSync(root.rootDir, { withFileTypes: true }).map((entry) => [entry.name, entry]),
    );
    assert.equal(root.directory.entries.length, actualEntries.size);
    for (const entry of root.directory.entries) {
      directoryRecords++;
      nativeDirents += Number(entry instanceof fs.Dirent);
      const actual = actualEntries.get(entry.name);
      assert(actual);
      assert.deepEqual(
        [entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()],
        [actual.isFile(), actual.isDirectory(), actual.isSymbolicLink()],
      );
    }
    for (const [name, facts] of [...root.paths].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const stat = facts.stat ?? facts.lstat;
      assert(stat);
      statRecords++;
      nativeStats += Number(stat instanceof fs.Stats);
      const file = path.join(root.rootDir, name);
      const actual = facts.stat ? fs.statSync(file) : fs.lstatSync(file);
      for (const field of ["mode", "uid", "nlink", "dev", "ino", "size", "mtimeMs"] as const) {
        assert.equal(stat[field], actual[field], `${file}: ${field}`);
      }
      const types = [stat.isFile(), stat.isDirectory(), stat.isSymbolicLink()];
      assert.deepEqual(types, [actual.isFile(), actual.isDirectory(), actual.isSymbolicLink()]);
      // Identity and timestamps differ between fixture arms; equality is checked above.
      checksum.update(
        JSON.stringify([path.basename(root.rootDir), name, types, actual.mode, actual.nlink]),
      );
    }
  }
  assert.equal(statRecords, entries);
  assert.equal(directoryRecords, entries);
  return {
    statRecords,
    directoryRecords,
    nativeStats,
    nativeDirents,
    checksum: checksum.digest("hex"),
  };
}

try {
  for (let plugin = 0; plugin < plugins; plugin++) {
    const directory = path.join(fixture, `plugin-${plugin}`);
    fs.mkdirSync(directory);
    directories.push(directory);
    const count = Math.floor(entries / plugins) + Number(plugin < entries % plugins);
    for (let index = 0; index < count; index++) {
      const file = path.join(directory, `entry-${String(index).padStart(6, "0")}`);
      if (index === 0) {
        fs.mkdirSync(file);
      } else if (index === 1) {
        fs.symlinkSync(path.join("..", "payload"), file);
      } else {
        fs.linkSync(payload, file);
      }
    }
  }
  acquire();
  await collect();
  const memoryBefore = process.memoryUsage();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  let cache: ReturnType<typeof acquire> | undefined;
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    cache = acquire();
  }
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const allocatedBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  inspector.disconnect();
  await collect();
  const memoryAfter = process.memoryUsage();
  assert(cache);
  const snapshot = values.snapshot
    ? writeHeapSnapshot(path.join(output, "retained.heapsnapshot"))
    : undefined;
  const result = {
    node: process.version,
    owner: values.owner ?? ownerUrl,
    mode: values.allocations ? "allocation" : "timing",
    entries,
    plugins,
    iterations,
    acquisitions: entries * iterations,
    directoryReads: plugins * iterations,
    cpuMs: (used.user + used.system) / 1000,
    wallMs,
    allocatedBytes,
    retainedHeapBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    ...verify(cache),
    snapshot,
  };
  fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector.disconnect();
  fs.rmSync(fixture, { recursive: true, force: true });
}
