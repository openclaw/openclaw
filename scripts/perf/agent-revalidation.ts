// Owner-only benchmark; no Gateway, credentials, network, or persisted state.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-revalidation.ts
//   --scenario matching|resolved|resources --mode timing|allocation|counts
//   --iterations 5000 --warmup 500 [--subject <module path>]
// Run five alternating base/candidate pairs with identical fixtures: 40 plugins
// for model routes, 64 resources per form. --subject accepts a frozen source
// module whose relative imports still resolve against the same dependency tree.
// Accept identical results and fewer comparisons/alias passes; compare untraced
// CPU/work and separately sampled allocation/work. Whole-Gateway impact is unmeasured.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { compileStructuredInputField } from "../../src/agents/harness/structured-input-schema.js";
import type { materializePreparedRuntimeModel } from "../../src/agents/runtime-plan/materialize-model.js";
import type { AgentRuntimeAuthPlan } from "../../src/agents/runtime-plan/types.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "matching" },
    mode: { type: "string", default: "timing" },
    subject: { type: "string" },
    iterations: { type: "string", default: "5000" },
    warmup: { type: "string", default: "500" },
  },
});
assert(["matching", "resolved", "resources"].includes(values.scenario));
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "--warmup",
  min: 1,
  fallback: 500,
});
const resources = values.scenario === "resources";
const subject =
  values.subject ??
  (resources
    ? "src/agents/harness/structured-input-schema.ts"
    : "src/agents/runtime-plan/materialize-model.ts");
let comparisons = 0;
let countComparisons = () => comparisons;
let resetComparisons = () => {
  comparisons = 0;
};
let restore = () => {};
let run: () => unknown;
if (resources) {
  const { compileStructuredInputField: compile } = (await import(
    pathToFileURL(path.resolve(subject)).href
  )) as {
    compileStructuredInputField: typeof compileStructuredInputField;
  };
  const options = Array.from({ length: 64 }, (_, index) => ({
    uri: `cad://parts/item-${index}`,
    name: `Part ${index}`,
  }));
  const schema = {
    type: "array",
    items: { type: "string", format: "uri" },
    "x-openai-input": { type: "resource", options },
  };
  if (values.mode === "counts") {
    const lower = mock.method(String.prototype, "toLowerCase");
    countComparisons = () =>
      lower.mock.calls.filter(
        (call) => typeof call.this === "string" && call.this.startsWith("cad://parts/item-"),
      ).length;
    resetComparisons = () => lower.mock.resetCalls();
    restore = () => lower.mock.restore();
  }
  run = () => {
    const field = compile(
      { fieldId: "parts", questionId: "parts", required: false, secret: false },
      schema,
      { protocolName: "benchmark", allowRichForms: true },
    );
    assert.notEqual(typeof field, "string");
    assert(typeof field !== "string" && field.question.options?.length === 64);
  };
} else {
  const { materializePreparedRuntimeModel: materialize } = (await import(
    pathToFileURL(path.resolve(subject)).href
  )) as {
    materializePreparedRuntimeModel: typeof materializePreparedRuntimeModel;
  };
  const api = "openai-responses" as const;
  const model = {
    provider: "fixture-0",
    id: "current",
    api,
    baseUrl: "https://provider.example/v1",
  };
  if (values.mode === "counts") {
    Object.defineProperty(model, "api", {
      get() {
        comparisons++;
        return api;
      },
    });
  }
  const plugins = Array.from({ length: 40 }, (_, index) => ({
    id: `plugin-${index}`,
    providers: [`fixture-${index}`],
    enabledByDefault: true,
    modelCatalog: {
      suppressions: [
        { provider: `fixture-${index}`, model: "retired", retirement: { replacedBy: "current" } },
      ],
    },
  }));
  const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins });
  const plan: AgentRuntimeAuthPlan = {
    providerForAuth: model.provider,
    authProfileProviderForAuth: model.provider,
    modelRoute: {
      provider: model.provider,
      modelId: model.id,
      api,
      baseUrl: model.baseUrl,
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    },
  };
  const request = {
    provider: model.provider,
    modelId: model.id,
    plan,
    metadataSnapshot,
    config: {
      plugins: { entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])) },
    },
    ...(values.scenario === "matching" ? { model } : {}),
    resolveModel: async () => ({ model }),
  };
  run = async () => {
    assert.equal(await materialize(request), model);
  };
}
async function repeat(count: number) {
  for (let index = 0; index < count; index++) {
    if (resources) {
      run();
    } else {
      await run();
    }
  }
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
try {
  await repeat(warmup);
  resetComparisons();
  global.gc();
  await nextTurn();
  const hostLoadStart = loadavg();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.threadCpuUsage();
  const start = performance.now();
  await repeat(iterations);
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(before);
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  console.log(
    JSON.stringify({
      scenario: values.scenario,
      mode: values.mode,
      iterations,
      warmup,
      subject,
      elapsedMs,
      mainThreadCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      allocatedBytesPerOperation: profile ? allocated(profile.head) / iterations : undefined,
      comparisonsPerOperation:
        values.mode === "counts" ? countComparisons() / iterations : undefined,
      hostLoadStart,
      hostLoadEnd: loadavg(),
      ...process.memoryUsage(),
    }),
  );
} finally {
  restore();
  inspector.disconnect();
}
