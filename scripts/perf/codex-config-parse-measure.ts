/**
 * Codex request config preparation: parse + timeout read + runtime options.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/codex-config-parse-measure.ts
 * --iterations 5000 --samples 5 [--module-dir <baseline app-server source directory>]
 * Synthetic 40-plugin config; live publication and captured config reads interleave.
 * Compare base/candidate with alternating launch order. CPU is untraced; allocation
 * sampling runs separately and includes collected objects. No app-server is spawned.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as currentOptions from "../../extensions/codex/src/app-server/config-options.js";
import * as currentParsing from "../../extensions/codex/src/app-server/config-parsing.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../src/config/runtime-source-projection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    samples: { type: "string", default: "5" },
    "module-dir": { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 5000,
});
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "samples",
  min: 1,
  fallback: 5,
});
const { readCodexPluginConfig }: typeof currentParsing = values["module-dir"]
  ? await import(pathToFileURL(path.resolve(values["module-dir"], "config-parsing.ts")).href)
  : currentParsing;
const { createCodexAppServerConfig, resolveCodexAppServerRequestTimeoutMs }: typeof currentOptions =
  values["module-dir"]
    ? await import(pathToFileURL(path.resolve(values["module-dir"], "config-options.ts")).href)
    : currentOptions;
const { resolveCodexAppServerRuntimeOptions } = createCodexAppServerConfig({
  resolveProviderIdForAuth: (provider) => provider,
});
const pluginConfig = {
  appServer: {
    requestTimeoutMs: 1234,
    mode: "yolo",
    approvalPolicy: "never",
    command: "codex",
    args: ["app-server"],
    headers: {},
    clearEnv: ["OPENAI_API_KEY"],
  },
  supervision: { enabled: true, allowRawTranscripts: false, allowWriteControls: false },
  computerUse: { enabled: false },
  codexPlugins: {
    enabled: true,
    plugins: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `plugin-${i}`,
        {
          enabled: true,
          marketplaceName: "synthetic",
          pluginName: `plugin-${i}`,
          allow_destructive_actions: "ask",
        },
      ]),
    ),
  },
};
const config = { plugins: { entries: { codex: { config: pluginConfig } } } };
setRuntimeConfigSnapshot(config);
const captured = captureRuntimeConfig(config).plugins!.entries!.codex!.config;
const inputs = [pluginConfig, captured];
assert.ok(globalThis.gc, "Run with --expose-gc");
function run() {
  for (let i = 0; i < iterations; i++) {
    const input = inputs[i % inputs.length];
    const parsed = readCodexPluginConfig(input);
    assert.equal(resolveCodexAppServerRequestTimeoutMs(parsed), 1234);
    assert.equal(
      resolveCodexAppServerRuntimeOptions({
        pluginConfig: parsed,
        env: {},
        requirementsToml: null,
        codexConfigToml: null,
      }).requestTimeoutMs,
      1234,
    );
  }
}
function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
}
run();
const inspector = new Session();
inspector.connect();
const rows = [];
try {
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc();
    const hostLoad = loadavg();
    const start = process.cpuUsage();
    const wallStart = performance.now();
    run();
    const cpu = process.cpuUsage(start);
    const wallMs = performance.now() - wallStart;
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    rows.push({
      sample,
      cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
      wallUsPerRequest: (wallMs * 1000) / iterations,
      sampledBytesPerRequest: bytes(profile.head) / iterations,
      hostLoad,
    });
  }
} finally {
  inspector.disconnect();
  clearRuntimeConfigSnapshot();
}
console.log(JSON.stringify({ node: process.version, iterations, samples, rows }, null, 2));
