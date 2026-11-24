/**
 * Capture real producer shapes with session-row-refresh-measure.ts --freeze-fixture
 * <file> --mixed --sessions 5000 (also pass --allow-natives-syntax to node).
 * Then: node --allow-natives-syntax --expose-gc --import ./scripts/tsx.mjs \
 * scripts/perf/session-row-freeze-measure.mjs <fixture> <baseline-identity.ts> <candidate-identity.ts>
 * Five interleaved pairs and baseline A/A, timing separately from collected-inclusive
 * sampling. Input construction is outside freeze measurements. Owner replay measures
 * actual construction separately; the no-delete arm intentionally retains undefined keys.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction } from "node:vm";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.ts";

const [fixtureFile, baselineFile, candidateFile] = process.argv.slice(2);
assert(fixtureFile && baselineFile && candidateFile && globalThis.gc);
const fast = compileFunction("return %HasFastProperties(row)", ["row"]);
const sameMap = compileFunction("return %HaveSameMap(a, b)", ["a", "b"]);
const hashes = {};
function loadFreeze(file, noDelete = false) {
  const source = readFileSync(file, "utf8");
  hashes[file] = createHash("sha256").update(source).digest("hex");
  let functions = source.slice(
    source.indexOf("function sameRowField("),
    source.indexOf("const rowIds"),
  );
  if (noDelete) {
    functions = functions.replace("Reflect.deleteProperty(row, field);", "");
  }
  return compileFunction(
    `${stripTypeScriptTypes(functions.replaceAll("export ", ""))}\nreturn freezeSessionRow;`,
    ["freezeTrustedJsonSnapshot"],
  )(freezeTrustedJsonSnapshot);
}
const baseline = loadFreeze(baselineFile);
const noDelete = loadFreeze(baselineFile, true);
const candidate = loadFreeze(candidateFile);
const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
assert(
  fixtures.every(
    (fixture) =>
      typeof fixture.patch === "boolean" && (!fixture.patch || Array.isArray(fixture.fields)),
  ),
);
const inspector = new Session();
inspector.connect();
const iterations = 10000;
const results = [];
function allocated(node, native = {}) {
  if (node.callFrame.scriptId === "0" && node.selfSize) {
    const name = node.callFrame.functionName || "[native]";
    native[name] = (native[name] ?? 0) + node.selfSize;
  }
  return (
    node.selfSize + node.children.reduce((total, child) => total + allocated(child, native), 0)
  );
}
for (const fixture of fixtures.slice(0, 2)) {
  const values = fixture.entries.map(({ defined, value }) =>
    defined ? freezeTrustedJsonSnapshot(value) : undefined,
  );
  function factory(omit) {
    const fields = fixture.entries.flatMap(({ key, defined }, index) =>
      omit && !defined ? [] : [`${JSON.stringify(key)}:values[${index}]`],
    );
    return compileFunction(`return {${fields.join(",")}}`, ["values"]).bind(null, values);
  }
  const full = factory(false);
  const omitted = factory(true);
  const freezeFields = (freeze) => (row) => freeze(row, undefined, fixture.fields);
  const arms = {
    baseline: [full, freezeFields(baseline)],
    candidate: [omitted, freezeFields(candidate)],
    noDelete: [full, freezeFields(noDelete)],
  };
  const state = {};
  for (const [name, [make, freeze]] of Object.entries(arms)) {
    for (let i = 0; i < 10000; i++) {
      freeze(make());
    }
    const a = make();
    const beforeFast = fast(a);
    freeze(a);
    const b = freeze(make());
    state[name] = {
      beforeFast,
      afterFast: fast(a),
      sharedMap: sameMap(a, b),
      fields: Object.keys(a).length,
    };
    assert.equal(JSON.stringify(a), JSON.stringify(baseline(full())));
    if (name === "candidate") {
      assert(fast(a) && sameMap(a, b));
      assert(Object.values(a).every((value) => value !== undefined));
    }
  }
  const samples = [];
  for (const mode of ["timing", "allocation"]) {
    for (const label of ["aa-1", "aa-2", ...Array.from({ length: 5 }, (_, i) => `pair-${i + 1}`)]) {
      for (const name of label.startsWith("aa") ? ["baseline"] : ["baseline", "candidate"]) {
        const [make, freeze] = arms[name];
        const rows = Array.from({ length: iterations }, make);
        globalThis.gc();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        for (const row of rows) {
          freeze(row);
        }
        const elapsedMs = performance.now() - start;
        const used = process.threadCpuUsage(cpu);
        const native = {};
        const bytes =
          mode === "allocation"
            ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head, native)
            : undefined;
        samples.push({
          mode,
          label,
          name,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          bytesPerFreeze: bytes === undefined ? undefined : bytes / iterations,
          nativeBytesPerFreeze:
            bytes === undefined
              ? undefined
              : Object.values(native).reduce((a, b) => a + b, 0) / iterations,
          native,
        });
      }
    }
  }
  // Separate Object.freeze itself from the deletion performed by freezeSessionRow.
  const freezeOnly = [];
  for (const name of ["dictionary", "full-fast", "omitted-fast"]) {
    const rows = Array.from({ length: iterations }, name === "omitted-fast" ? omitted : full);
    if (name === "dictionary") {
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (row[key] === undefined) {
            Reflect.deleteProperty(row, key);
          }
        }
      }
    }
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (const row of rows) {
      Object.freeze(row);
    }
    const native = {};
    const bytes = allocated(
      (await inspector.post("HeapProfiler.stopSampling")).profile.head,
      native,
    );
    globalThis.gc();
    const retainedHeapDeltaPerRow = (process.memoryUsage().heapUsed - heapBefore) / iterations;
    freezeOnly.push({
      name,
      sampledBytesPerFreeze: bytes / iterations,
      native,
      retainedHeapDeltaPerRow,
      fast: fast(rows[0]),
      sharedMap: sameMap(rows[0], rows[1]),
    });
  }
  results.push({
    capturedBeforeFast: fixture.beforeFast,
    capturedAfterFast: fixture.afterFast,
    inputFields: fixture.entries.length,
    patchFields: fixture.fields,
    state,
    samples,
    freezeOnly,
  });
}
inspector.disconnect();
console.log(
  JSON.stringify(
    { node: process.version, v8: process.versions.v8, iterations, hashes, results },
    null,
    2,
  ),
);
