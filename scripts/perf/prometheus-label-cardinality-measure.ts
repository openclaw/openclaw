/**
 * node --import ./scripts/tsx.mjs scripts/perf/prometheus-label-cardinality-measure.ts <output.json>
 * Synthetic exporter-owner proof: 10,800 sessions, scoped/custom lanes, six client
 * kinds and all model/cron request shapes. No database or workspace I/O is involved.
 * Run identical-source controls and five interleaved base/candidate processes.
 * Acceptance: closed queue labels, complete request counts, zero drops, unchanged
 * budgets; compare warm owner CPU/allocation and cold admission separately.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import { getHeapStatistics } from "node:v8";
import type {
  DiagnosticEventPayload,
  OpenClawPluginServiceContext,
} from "../../extensions/diagnostics-prometheus/api.js";
import { cardinalityEvents } from "../../extensions/diagnostics-prometheus/src/label-cardinality.test-support.js";
import { createDiagnosticsPrometheusExporter } from "../../extensions/diagnostics-prometheus/src/service.js";
import { listenOnLoopback } from "../../extensions/test-support/hanging-loopback-server.js";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.js";

const output = process.argv[2];
assert(output, "output.json required");
const events = cardinalityEvents();
const exporter = createDiagnosticsPrometheusExporter();
let record: ((event: DiagnosticEventPayload) => void) | undefined;
const context: OpenClawPluginServiceContext = {
  config: {},
  stateDir: "unused-synthetic-state",
  logger: {
    info() {},
    warn() {},
    error(message) {
      throw new Error(message);
    },
  },
  internalDiagnostics: {
    emit() {},
    onEvent(listener) {
      record = (event) => listener(event, { trusted: true }, {});
      return () => {};
    },
  },
};
exporter.service.start(context);
assert(record);
const observe = record;
function measure(action: () => void) {
  const allocated = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocated), "Node allocation counters required");
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  action();
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  return {
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    allocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
  };
}
function batch() {
  for (const event of events) {
    observe(event);
  }
}
const hostLoad = loadavg();
const cold = measure(batch);
for (let index = 0; index < 3; index++) {
  batch();
}
const warm = measure(batch);
const server = createServer((request, response) => {
  void withPluginRuntimeGatewayRequestScope(
    {
      isWebchatConnect: () => false,
      client: {
        connId: "synthetic",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          scopes: ["operator.read"],
          role: "operator",
          client: { id: "cli", version: "synthetic", platform: "synthetic", mode: "cli" },
        },
      },
    },
    () => exporter.handler(request, response),
  );
});
let body: string;
try {
  const port = await listenOnLoopback(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`);
  assert.equal(response.status, 200);
  body = await response.text();
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
const samples = body.split("\n").filter((line) => line && !line.startsWith("#"));
const families = Object.fromEntries(
  [
    "openclaw_queue_lane_size",
    "openclaw_queue_lane_wait_seconds_count",
    "openclaw_models_list_requests_total",
    "openclaw_cron_list_requests_total",
  ].map((name) => {
    const lines = samples.filter((line) => line.startsWith(`${name}{`));
    return [
      name,
      {
        series: lines.length,
        total: lines.reduce((n, line) => n + Number(line.split(" ").at(-1)), 0),
      },
    ];
  }),
);
await writeFile(
  output,
  JSON.stringify(
    {
      node: process.version,
      hostLoad,
      events: events.length,
      passes: 5,
      cold,
      warm,
      families,
      rows: samples.length,
      bytes: Buffer.byteLength(body),
      drops: samples.filter((line) =>
        line.startsWith("openclaw_prometheus_family_series_dropped_total"),
      ),
    },
    null,
    2,
  ) + "\n",
);
exporter.service.stop();
