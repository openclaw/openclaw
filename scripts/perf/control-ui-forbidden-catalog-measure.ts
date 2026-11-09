// Owner-only permission-denied discovery benchmark; no Gateway or network is used.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/control-ui-forbidden-catalog-measure.ts
// Add --allocations for a separate sampled-allocation pass; never gate its timing.
// --module <catalog-target.ts> selects an exact baseline module with its imports intact.
// Five session-only clients alternate agents over 5,000 picker activations, with 40
// advertised plugin methods. Session row cardinality is irrelevant to this owner.
// Acceptance: zero denied requests/CLI groups, lower CPU and allocation per activation.
// The mock rejection includes client error handling, not server authorization cost.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GatewayBrowserClient, GatewayRequestError } from "../../ui/src/api/gateway.ts";
import type { CatalogTargetDiscovery as Discovery } from "../../ui/src/pages/new-session/catalog-target.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../ui/src/test-helpers/application-context-fixtures.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string", default: "ui/src/pages/new-session/catalog-target.ts" },
    activations: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
  },
});
const activations = parseStrictIntegerOption({
  raw: values.activations,
  label: "--activations",
  min: 1,
  fallback: 5000,
});
assert(global.gc, "Run with --expose-gc");
// SAFETY: --module selects the same catalog owner API from the baseline or candidate.
const { CatalogTargetDiscovery } = (await import(
  pathToFileURL(path.resolve(values.module)).href
)) as {
  CatalogTargetDiscovery: typeof Discovery;
};
let requests = 0;
let groups = 0;
const clients = Array.from({ length: 5 }, () => {
  const client = new GatewayBrowserClient({ url: "ws://synthetic.invalid" });
  client.request = async () => {
    requests++;
    throw new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" });
  };
  // The discovery owner consumes only this connection snapshot; no app lifecycle runs.
  const context = {
    gateway: createApplicationGateway(
      createApplicationGatewaySnapshot({
        phase: "connected",
        client,
        hello: {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.sessions.read"] },
          features: {
            methods: [
              ...Array.from({ length: 40 }, (_, index) => `plugin.synthetic${index}.list`),
              "sessions.catalog.list",
            ],
          },
        },
      }),
    ).gateway,
  };
  return { context, discovery: new CatalogTargetDiscovery(() => {}) };
});

async function run(count: number) {
  for (let index = 0; index < count; index++) {
    const { context, discovery } = clients[index % clients.length]!;
    discovery.load(context, `agent-${Math.floor(index / clients.length) % 2}`, true);
    const result = discovery.groups();
    groups += result?.length ?? 0;
    await result?.[0]?.completion?.promise.catch(() => {});
  }
  for (const { discovery } of clients) {
    discovery.clear();
  }
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
try {
  await run(500);
  global.gc();
  await nextTurn();
  requests = 0;
  groups = 0;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.threadCpuUsage();
  const started = performance.now();
  await run(activations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(before);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      module: values.module,
      mode: values.allocations ? "allocations" : "timing",
      activations,
      clients: clients.length,
      advertisedPlugins: 40,
      deniedRequests: requests,
      exposedCliGroups: groups,
      elapsedMs,
      mainThreadCpuUsPerActivation: (cpu.user + cpu.system) / activations,
      allocatedBytesPerActivation: profile ? allocated(profile.head) / activations : undefined,
      hostLoad: loadavg(),
      ...process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
}
