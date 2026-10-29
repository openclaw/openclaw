/**
 * Owner attribution, supplementary to code-mode-json-gateway-measure.ts.
 * Bundle src/agents/code-mode-json.ts with esbuild (node/esm, packages external)
 * for each pinned revision, then run:
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-json-fit-measure.ts <bundle.mjs>
 * --allocations samples collected objects separately from untraced CPU/timing.
 */
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const {
  CodeModeOutputState,
  captureCodeModeValue,
  captureCodeModeOutput,
}: typeof import("../../src/agents/code-mode-json.js") = await import(
  pathToFileURL(path.resolve(process.argv[2]!)).href
);
const allocations = process.argv.includes("--allocations");
const inspector = new Session();
if (allocations) {
  inspector.connect();
}
const budget = { maxChars: 16_000, maxContextChars: 32_000 };
const metadata = { status: "completed", telemetry: { calls: 1 } };
try {
  for (const scenario of [
    "small",
    "value",
    "output",
    "mixed",
    "unicode",
    "error",
    "network",
    "network-small",
  ]) {
    const small = scenario === "small" || scenario === "network-small";
    const text = small
      ? "x".repeat(64)
      : scenario === "unicode"
        ? '漢🌍\\"\n'.repeat(12_000)
        : "x".repeat(64_000);
    const value = captureCodeModeValue(text, 65_536);
    const output = captureCodeModeOutput([{ type: "text", text }], 65_536);
    const invoke = () => {
      const state = new CodeModeOutputState(65_536, budget);
      if (["output", "mixed", "unicode"].includes(scenario)) {
        state.append(output);
      }
      return state.takeResult(
        metadata,
        {
          ...(scenario === "output" || scenario === "error" ? {} : { value }),
          ...(scenario === "error" ? { error: text } : {}),
        },
        scenario.startsWith("network"),
      );
    };
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    let stringifyCalls = 0;
    let serializedChars = 0;
    let parsedChars = 0;
    let result;
    try {
      JSON.stringify = (input: unknown, replacer, space) => {
        stringifyCalls++;
        const json =
          typeof replacer === "function"
            ? stringify(input, replacer, space)
            : stringify(input, replacer, space);
        serializedChars += json?.length ?? 0;
        return json;
      };
      JSON.parse = (...args) => {
        parsedChars += args[0].length;
        return Reflect.apply(parse, JSON, args);
      };
      result = invoke();
    } finally {
      JSON.stringify = stringify;
      JSON.parse = parse;
    }
    const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    for (let warmup = 0; warmup < 50; warmup++) {
      invoke();
    }
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    // Amplify the small-result control above CPU clock granularity.
    const iterations = small ? 20_000 : 200;
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      const cpu = process.threadCpuUsage();
      for (let iteration = 0; iteration < iterations; iteration++) {
        invoke();
      }
      const used = process.threadCpuUsage(cpu);
      samples.push({
        elapsedMs: performance.now() - start,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
    let sampledBytes: number | undefined;
    if (allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      sampledBytes = 0;
      for (const node of nodes) {
        sampledBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    console.log(
      JSON.stringify({
        scenario,
        digest,
        stringifyCalls,
        serializedChars,
        parsedChars,
        operations: iterations * 5,
        samples,
        sampledBytes,
      }),
    );
  }
} finally {
  if (allocations) {
    inspector.disconnect();
  }
}
