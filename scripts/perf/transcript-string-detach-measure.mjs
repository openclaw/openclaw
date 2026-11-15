/**
 * Synthetic transcript owner proof; no Gateway, provider, or database traffic.
 * node --expose-gc scripts/perf/transcript-string-detach-measure.mjs OWNER.ts OUTPUT_DIR [--heap]
 * Save the baseline owner with git show before editing. Both arms bundle that owner
 * against this checkout's unchanged dependencies. Run five alternating fresh-process
 * pairs. --heap separately checks backing-string retainers, including a positive
 * control, without string comparisons that could flatten the inputs before capture.
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { build } from "esbuild";

const [ownerFile, directory] = process.argv.slice(2);
assert(ownerFile && directory && global.gc, "OWNER.ts OUTPUT_DIR and --expose-gc required");
const output = path.resolve(directory);
mkdirSync(output, { recursive: true });
await build({
  stdin: {
    contents: readFileSync(ownerFile, "utf8"),
    resolveDir: path.resolve("src/config/sessions"),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(output, "owner.mjs"),
});
const { normalizeTranscriptJsonValue: normalize } = await import(
  pathToFileURL(path.join(output, "owner.mjs")).href
);
const collect = async () => {
  await setImmediate();
  global.gc();
  global.gc();
};

if (process.argv.includes("--heap")) {
  function sources() {
    const donor = Buffer.alloc(2 * 1024 ** 2, 0x61).toString();
    const unicodeDonor = Buffer.alloc(4 * 1024 ** 2, 0x61).toString("utf16le");
    return {
      shortSlice: donor.slice(64, 76),
      shortCons: donor.slice(64, 70) + donor.slice(80, 86),
      slice13: donor.slice(64, 77),
      longSlice: donor.slice(64, 2112),
      cons: donor.slice(64, 1088) + donor.slice(2048, 3072),
      parsed: JSON.parse(`{"text":"${donor}"}`).text.slice(64, 76),
      unicodeShort: unicodeDonor.slice(64, 76),
      unicodeBoundary: unicodeDonor.slice(64, 77),
    };
  }
  const raw = sources();
  globalThis.stringDetachmentProof = {
    rawShortSlice: raw.shortSlice,
    rawShortCons: raw.shortCons,
    rawParsedShort: raw.parsed,
    rawUnicodeShort: raw.unicodeShort,
    controlSlice13: raw.slice13,
    controlUnicode13: raw.unicodeBoundary,
    controlCons: raw.cons,
    ...normalize(sources(), ""),
  };
  await collect();
  const file = writeHeapSnapshot(path.join(output, "retainers.heapsnapshot"));
  const {
    nodes,
    edges,
    strings,
    snapshot: { meta },
  } = JSON.parse(readFileSync(file, "utf8"));
  const nf = meta.node_fields,
    ef = meta.edge_fields;
  const width = nf.length,
    ew = ef.length;
  const type = nf.indexOf("type"),
    size = nf.indexOf("self_size"),
    count = nf.indexOf("edge_count");
  const et = ef.indexOf("type"),
    en = ef.indexOf("name_or_index"),
    to = ef.indexOf("to_node");
  const starts = new Map();
  let cursor = 0,
    root;
  for (let node = 0; node < nodes.length; node += width) {
    starts.set(node, cursor);
    for (let i = 0; i < nodes[node + count]; i++, cursor += ew) {
      if (
        meta.edge_types[et][edges[cursor + et]] === "property" &&
        strings[edges[cursor + en]] === "stringDetachmentProof"
      ) {
        root = edges[cursor + to];
      }
    }
  }
  assert(root !== undefined);
  const children = (node) => {
    const result = [];
    for (let i = 0, e = starts.get(node); i < nodes[node + count]; i++, e += ew) {
      result.push({ name: strings[edges[e + en]], node: edges[e + to] });
    }
    return result;
  };
  const inspect = (node) => {
    const kind = meta.node_types[type][nodes[node + type]];
    const backing = children(node).filter((e) =>
      ["parent", "first", "second", "actual"].includes(e.name),
    );
    return {
      kind,
      maxBackingBytes: Math.max(
        nodes[node + size],
        ...backing.map((e) => inspect(e.node).maxBackingBytes),
      ),
    };
  };
  const report = Object.fromEntries(
    children(root)
      .filter((e) => Object.hasOwn(globalThis.stringDetachmentProof, e.name))
      .map((e) => [e.name, inspect(e.node)]),
  );
  writeFileSync(path.join(output, "retainers.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  assert(report.controlSlice13.maxBackingBytes >= 2 * 1024 ** 2);
  assert(report.controlCons.maxBackingBytes >= 2 * 1024 ** 2);
  assert(report.controlUnicode13.maxBackingBytes >= 4 * 1024 ** 2);
  for (const [name, value] of Object.entries(report)) {
    if (!name.startsWith("control")) {
      assert(value.maxBackingBytes < 8192, `${name} retained its donor`);
    }
  }
  unlinkSync(file);
} else {
  const iterations = 3000;
  function fixture(index) {
    const donor = Buffer.alloc(24 * 1024, 65 + (index % 26)).toString();
    return {
      type: "message",
      id: String(index),
      parentId: String(index - 1),
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: `call-${index}`,
        content: [{ type: "text", text: donor.slice(1024, 17 * 1024) }],
        details: {
          status: "completed",
          exitCode: 0,
          chunks: Array.from({ length: 12 }, (_, i) => ({
            channel: "stdout",
            label: `chunk-${i}`,
            text: donor.slice(i, i + 12),
          })),
        },
      },
    };
  }
  for (let i = 0; i < 100; i++) {
    normalize(fixture(i), "");
  }
  const inputs = Array.from({ length: iterations }, (_, i) => fixture(i));
  await collect();
  const pauses = [];
  const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const allocated = getHeapStatistics().total_allocated_bytes;
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let i = 0; i < inputs.length; i++) {
    inputs[i] = normalize(inputs[i], "");
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
  await setImmediate();
  await setImmediate();
  pauses.push(...observer.takeRecords());
  observer.disconnect();
  await collect();
  const memory = process.memoryUsage();
  // Count separately so instrumentation does not enter allocation/CPU measurements.
  const from = Buffer.from;
  let copies = 0,
    copiedBytes = 0,
    shortCopies = 0;
  Buffer.from = function (...args) {
    if (typeof args[0] === "string" && args[1] === "utf16le") {
      copies++;
      copiedBytes += args[0].length * 2;
      if (args[0].length < 13) {
        shortCopies++;
      }
    }
    return Reflect.apply(from, Buffer, args);
  };
  try {
    normalize(fixture(0), "");
  } finally {
    Buffer.from = from;
  }
  const report = {
    node: process.version,
    v8: process.versions.v8,
    iterations,
    load: loadavg(),
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    memory,
    copiesPerEntry: copies,
    copiedBytesPerEntry: copiedBytes,
    shortCopiesPerEntry: shortCopies,
    gc: {
      count: pauses.length,
      totalMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
      maxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
      byKind: [...new Set(pauses.map((pause) => pause.detail.kind))].map((kind) => ({
        kind,
        count: pauses.filter((pause) => pause.detail.kind === kind).length,
        totalMs: pauses
          .filter((pause) => pause.detail.kind === kind)
          .reduce((sum, pause) => sum + pause.duration, 0),
      })),
    },
  };
  writeFileSync(path.join(output, "measurement.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  assert.equal(inputs.length, iterations);
  assert.equal(inputs[0].message.content[0].text.length, 16 * 1024);
}
