import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { inspectBase64 as baseline } from "../../../packages/media-core/src/base64.ts";
import { createScanner, wasmBytes } from "./adapter.mjs";
import { inspectBase64 as tableControl } from "./table-control.mjs";
const module = new WebAssembly.Module(wasmBytes);
const scanner = createScanner(module);
const candidate = scanner.inspectBase64;
let seed = 0xa071ac21;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
function payload(bytes) {
  const buffer = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) {
    buffer[i] = random() & 255;
  }
  return buffer.toString("base64");
}
const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[3], observedMax: sorted[6], min: sorted[0], samples: values };
};
let parityCalls = 0;
const fixed = [
  "",
  "S",
  "QQ==",
  "QUI=",
  "QUJD",
  "ZE==",
  "QQ",
  "QQ==\n",
  " Q Q = = ",
  "QQ$=",
  "QQ-_",
  "QQ=Q",
  "Q===",
  "====",
  "QQ==QQ==",
  "AAAé",
  "AAA\ud800",
  "AAA\0",
  "AA💥A",
];
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \t\n\r\0$-_é\ud800";
function check(input) {
  for (const dialect of ["attachment", "canonical"]) {
    assert.deepEqual(
      candidate(input, dialect),
      baseline(input, dialect),
      JSON.stringify({ input, dialect }),
    );
    assert.deepEqual(tableControl(input, dialect), baseline(input, dialect));
    parityCalls++;
  }
}
for (const input of fixed) {
  check(input);
}
for (let sample = 0; sample < 12000; sample++) {
  let input;
  if (sample % 3 === 0) {
    input = payload(random() % 256);
    if (sample % 2) {
      input = input.replaceAll("=", "");
    }
    if (sample % 5 === 0) {
      input = input.match(/.{1,7}/g)?.join("\n") ?? input;
    }
  } else {
    input = "";
    for (let i = random() % 256; i > 0; i--) {
      input += alphabet[random() % alphabet.length];
    }
  }
  check(input);
}
assert.equal(scanner.exports.scan(0xffffffff, 16, 0), -1);
assert.equal(scanner.exports.scan(0, 0xffffffff, 0), -1);
assert.equal(scanner.exports.scan(0, 0, 0), -1);
assert.equal(scanner.exports.scan(0, 4, 2), -1);
assert.throws(() => scanner.memory.grow(1025), RangeError);
const report = {
  node: process.version,
  cpu: os.cpus()[0].model,
  cpus: os.cpus().length,
  loadStart: os.loadavg(),
  oracle: "packages/media-core/src/base64.ts",
  oracleSha256: createHash("sha256")
    .update(readFileSync(new URL("../../../packages/media-core/src/base64.ts", import.meta.url)))
    .digest("hex"),
  artifactBytes: wasmBytes.length,
  artifactSha256: createHash("sha256").update(wasmBytes).digest("hex"),
  imports: WebAssembly.Module.imports(module),
  parityCalls,
  rows: [],
  cold: [],
};
const profile = process.argv[2];
if (
  process.argv.length > 3 ||
  (profile && !["--check", "--profile-base", "--profile-table", "--profile-wasm"].includes(profile))
) {
  throw new Error(
    "Usage: node measure.mjs [--check|--profile-base|--profile-table|--profile-wasm]",
  );
}
if (profile === "--check") {
  console.log(
    JSON.stringify({ parityCalls, artifactBytes: wasmBytes.length, imports: report.imports }),
  );
} else if (profile) {
  const operation =
    profile === "--profile-base"
      ? baseline
      : profile === "--profile-table"
        ? tableControl
        : candidate;
  const input = payload(1024 * 1024);
  let sink = 0;
  for (let i = 0; i < 100; i++) {
    sink += operation(input, "attachment").decodedBytes;
  }
  console.log(JSON.stringify({ profile, sink }));
} else {
  let sink = 0;
  for (const bytes of [160, 960, 3840, 65536, 1048576, 16777216]) {
    const base = payload(bytes);
    const shapes = bytes < 65536 ? ["canonical"] : ["canonical", "whitespace", "late-invalid"];
    for (const shape of shapes) {
      const input =
        shape === "whitespace"
          ? base.match(/.{1,76}/g).join("\r\n")
          : shape === "late-invalid"
            ? base.slice(0, -1) + "$"
            : base;
      const dialect = shape === "whitespace" ? "canonical" : "attachment";
      assert.deepEqual(candidate(input, dialect), baseline(input, dialect));
      assert.deepEqual(tableControl(input, dialect), baseline(input, dialect));
      const repeats = Math.max(1, Math.min(10000, Math.floor((2 * 1024 * 1024) / input.length)));
      const samples = { baseline: [], candidate: [], tableControl: [] },
        cpu = { baseline: [], candidate: [], tableControl: [] };
      for (let sample = -2; sample < 7; sample++) {
        const order =
          sample % 2
            ? ["candidate", "tableControl", "baseline"]
            : ["baseline", "tableControl", "candidate"];
        for (const name of order) {
          const operation =
            name === "baseline" ? baseline : name === "tableControl" ? tableControl : candidate;
          const usage = process.cpuUsage(),
            started = performance.now();
          for (let i = 0; i < repeats; i++) {
            sink += operation(input, dialect)?.decodedBytes ?? 1;
          }
          const elapsed = (performance.now() - started) / repeats,
            used = process.cpuUsage(usage);
          if (sample >= 0) {
            samples[name].push(elapsed);
            cpu[name].push((used.user + used.system) / 1000 / repeats);
          }
        }
      }
      report.rows.push({
        bytes,
        inputCharacters: input.length,
        shape,
        dialect,
        repeats,
        baselineMs: summarize(samples.baseline),
        candidateMs: summarize(samples.candidate),
        tableControlMs: summarize(samples.tableControl),
        tableControlCpuMs: summarize(cpu.tableControl),
        baselineCpuMs: summarize(cpu.baseline),
        candidateCpuMs: summarize(cpu.candidate),
      });
    }
  }
  const input = payload(1048576);
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    const cold = createScanner();
    const afterSetup = performance.now();
    const result = cold.inspectBase64(input, "attachment");
    const afterCall = performance.now();
    assert.deepEqual(result, baseline(input, "attachment"));
    report.cold.push({
      setupMs: afterSetup - start,
      firstCallMs: afterCall - afterSetup,
      memoryBytes: cold.memory.buffer.byteLength,
    });
  }
  report.retainedMemoryBytes = scanner.memory.buffer.byteLength;
  report.loadEnd = os.loadavg();
  report.sink = sink;
  console.log(JSON.stringify(report, null, 2));
}
