// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/connect-link-readers-measure.ts
// --source <saved control-ui-plugin-tabs.ts> loads the baseline at its original module URL.
// --compare-source <saved baseline> runs five alternating AB/BA pairs against current source.
// Repeat with --allocation for separate sampled-byte arms; both variants share one fixture.
// Measures hello link-reader projection: 40 plugins, 400 plugin methods, real core method names,
// and four readers with detail/preview/image methods. Fixture creation is outside measurement.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "compare-source": { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const owner = new URL("../../src/gateway/control-ui-plugin-tabs.ts", import.meta.url);
const source = readFileSync(values.source ?? owner, "utf8");
const baselineUrl = new URL(`${owner.href}?connect-link-readers-baseline`);
const baselineSource = values["compare-source"]
  ? readFileSync(values["compare-source"], "utf8")
  : undefined;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const selected =
      url === owner.href ? source : url === baselineUrl.href ? baselineSource : undefined;
    return selected === undefined
      ? nextLoad(url, context)
      : { format: "module-typescript", source: selected, shortCircuit: true };
  },
});
const { listControlUiLinkReaders } = await import("../../src/gateway/control-ui-plugin-tabs.ts");
const variants = [{ arm: "candidate", source, project: listControlUiLinkReaders }];
if (baselineSource !== undefined) {
  const baseline: typeof import("../../src/gateway/control-ui-plugin-tabs.ts") = await import(
    baselineUrl.href
  );
  variants.unshift({
    arm: "base",
    source: baselineSource,
    project: baseline.listControlUiLinkReaders,
  });
}
hooks.deregister();
const { createPluginRegistryFixture, registerVirtualTestPlugin } =
  await import("../../src/plugin-sdk/test-helpers/contracts-testkit.ts");
const { createGatewayMethodRegistry } = await import("../../src/gateway/methods/registry.ts");
const { listCoreGatewayMethodMetadata } =
  await import("../../src/gateway/methods/core-method-policy.ts");
const { withPluginRuntimeRegistryScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.ts");

const { config, registry } = createPluginRegistryFixture();
const expected = [];
for (let index = 0; index < 40; index++) {
  const id = `synthetic-${String(index).padStart(2, "0")}`;
  const label = `Synthetic reader ${index}`;
  const linkReader = {
    hosts: [`${id}.example`],
    pathPattern: "^/items/[0-9]+$",
    detailMethod: `${id}.read0`,
    previewMethod: `${id}.read1`,
    imageMethod: `${id}.read2`,
  };
  registerVirtualTestPlugin({
    config,
    registry,
    id,
    name: id,
    register(api) {
      for (let method = 0; method < 10; method++) {
        api.registerGatewayMethod(`${id}.read${method}`, () => undefined, {
          scope: "operator.read",
        });
      }
      api.session.controls.registerControlUiDescriptor({
        id: "panel",
        surface: "tab",
        label: `Synthetic panel ${index}`,
        requiredScopes: ["operator.read"],
      });
      if (index < 4) {
        api.session.controls.registerControlUiDescriptor({
          id: "document",
          surface: "link-reader",
          label,
          requiredScopes: ["operator.read"],
          linkReader,
        });
      }
    },
  });
  if (index < 4) {
    expected.push({ pluginId: id, id: "document", label, linkReader });
  }
}
const methods = createGatewayMethodRegistry(
  [
    ...listCoreGatewayMethodMetadata().map(({ name, scope, since }) => ({
      name,
      scope,
      since,
      handler: () => undefined,
      owner: { kind: "core" as const, area: "synthetic" },
    })),
    ...registry.registry.gatewayMethodDescriptors,
  ],
  registry.registry,
);
const operations = 5_000;
const scopes = ["operator.read"];
const expectedJson = JSON.stringify(expected);
function run(project: typeof listControlUiLinkReaders, count: number) {
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    checksum += project(scopes, methods).length;
  }
  return checksum;
}
async function measure(variant: (typeof variants)[number], pair: number, order: number) {
  global.gc!();
  const memoryBefore = process.memoryUsage();
  const hostLoadBefore = loadavg();
  const inspector = new Session();
  let sampledBytes: number | undefined;
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(variant.project, operations);
  const elapsedMs = performance.now() - started;
  const usedCpu = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    inspector.disconnect();
  }
  assert.equal(JSON.stringify(variant.project(scopes, methods)), expectedJson);
  console.log(
    JSON.stringify({
      sourceHash: hash("sha256", variant.source),
      responseHash: hash("sha256", expectedJson),
      mode: values.allocation ? "allocation" : "timing",
      arm: variant.arm,
      pair,
      order,
      operations,
      plugins: registry.registry.plugins.length,
      methods: methods.descriptors().length,
      readers: expected.length,
      elapsedMs,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      sampledBytes,
      sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / operations,
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      checksum,
    }),
  );
}
await withPluginRuntimeRegistryScope(registry.registry, async () => {
  for (const variant of variants) {
    assert.equal(JSON.stringify(variant.project(scopes, methods)), expectedJson);
    run(variant.project, 2_000);
  }
  for (let pair = 0; pair < (baselineSource === undefined ? 1 : 5); pair++) {
    const ordered = pair % 2 === 0 ? variants : variants.toReversed();
    for (const [order, variant] of ordered.entries()) {
      await measure(variant, pair + 1, order + 1);
    }
  }
});
