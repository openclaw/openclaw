// Direct sessions.list timing against two isolated, built model-policy-load Gateways.
// Start each scripts/perf/operator-model-policy-load.mjs with its own synthetic state,
// entry, port and --start-file, then leave both start files absent after "ready": true.
// This retains 64 subscribed clients but holds the mixed workload during direct timing.
// Verify each Gateway resolves its own pinned runtime artifacts before measuring.
// node --import ./scripts/tsx.mjs scripts/perf/operator-model-policy-list-probe.mjs \
//   --base-port 41736 --candidate-port 41738 --output .local/policy-list-direct.json
// Default: 50 warmup calls then 1,000 measured calls per variant per side. AB/BA order
// alternates within each variant. Every raw round-trip sample is retained; no trimming.
// Maintenance remains enabled. This isolates list RPCs; it does not replace mixed load.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    "base-port": { type: "string", default: "41736" },
    "candidate-port": { type: "string", default: "41738" },
    "calls-per-variant": { type: "string", default: "1000" },
    output: { type: "string" },
  },
});
assert(values.output, "--output is required");
const ports = [Number(values["base-port"]), Number(values["candidate-port"])];
assert(ports.every((port) => Number.isSafeInteger(port) && port >= 40000 && port < 65535));
assert.notEqual(ports[0], ports[1]);
const calls = Number(values["calls-per-variant"]);
assert(Number.isSafeInteger(calls) && calls >= 500);
const variants = [
  {
    name: "sidebar",
    params: { limit: 100, archived: false, rowMode: "sidebar", source: "sidebar" },
  },
  {
    name: "compact",
    params: { limit: 100, archived: false, rowMode: "compact", source: "agent-roster" },
  },
  {
    name: "search",
    params: {
      limit: 100,
      archived: "all",
      rowMode: "sidebar",
      source: "sidebar",
      search: "Team fixture",
    },
  },
];
const clients = [];
const samples = [];
const scopes = ["operator.admin", "operator.read", "operator.write"];
async function rpc(client, method, params) {
  const response = await client.request(method, params, 60000);
  assert(response.ok, JSON.stringify(response.error));
  return response.payload;
}
async function connect(port) {
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin: "https://model-policy-load.example.invalid",
    headers: {
      "x-forwarded-for": "203.0.113.171",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "model-policy-load.example.invalid",
      "x-forwarded-user": "model-policy-load@example.invalid",
    },
  });
  clients.push(client);
  await client.waitOpen();
  const hello = await rpc(client, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "openclaw-control-ui",
      displayName: "Synthetic list timing",
      version: "1",
      platform: process.platform,
      mode: "ui",
    },
    role: "operator",
    scopes,
    caps: ["model-selection-policy", "tool-events"],
  });
  assert.equal(hello.auth.method, "trusted-proxy");
  const self = await rpc(client, "users.self", {});
  assert(self.profile.id && self.profile.id !== "gateway-owner");
  const models = await rpc(client, "models.list", {});
  assert.equal(models.modelSelectionPolicy?.restricted, true);
  const all = await rpc(client, "sessions.list", { limit: 100, archived: "all" });
  assert(all.totalCount >= 10000);
  return { client, profileId: self.profile.id, totalCount: all.totalCount };
}
const summarize = (rows) => {
  const sorted = rows.map((row) => row.elapsedMs).toSorted((a, b) => a - b);
  assert(sorted.length > 0);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, x) => sum + x, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
};
try {
  const base = await connect(ports[0]);
  const candidate = await connect(ports[1]);
  const sides = [base, candidate];
  const startedAt = new Date().toISOString();
  const run = async (rounds, measured) => {
    for (let round = 0; round < rounds; round++) {
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
        const variant = variants[variantIndex];
        const order = (round + variantIndex) % 2 ? [1, 0] : [0, 1];
        const results = [];
        for (const side of order) {
          const start = performance.now();
          const result = await rpc(sides[side].client, "sessions.list", variant.params);
          const elapsedMs = performance.now() - start;
          assert.equal(typeof result.count, "number");
          assert(result.count > 0 && result.count <= 100);
          results[side] = result;
          if (measured) {
            samples.push({
              round,
              variant: variant.name,
              side: side === 0 ? "base" : "candidate",
              first: order[0] === side,
              elapsedMs,
              count: result.count,
              totalCount: result.totalCount,
            });
          }
        }
        assert.equal(
          results[0].totalCount,
          results[1].totalCount,
          "Both fixtures must expose the same list size",
        );
        assert.deepEqual(
          results[0].defaults,
          results[1].defaults,
          "Model defaults must remain equivalent",
        );
      }
      if (measured && (round + 1) % 100 === 0) {
        process.stdout.write(
          `${JSON.stringify({ progressRounds: round + 1, callsPerSide: (round + 1) * variants.length })}\n`,
        );
      }
    }
  };
  await run(50, false);
  const measurementStartedAt = new Date().toISOString();
  await run(calls, true);
  const summaries = {};
  for (const name of ["all", ...variants.map((variant) => variant.name)]) {
    summaries[name] = Object.fromEntries(
      ["base", "candidate"].map((side) => [
        side,
        summarize(
          samples.filter(
            (sample) => sample.side === side && (name === "all" || sample.variant === name),
          ),
        ),
      ]),
    );
  }
  const result = {
    startedAt,
    measurementStartedAt,
    finishedAt: new Date().toISOString(),
    ports,
    callsPerVariant: calls,
    warmupCallsPerVariant: 50,
    variants,
    fixtureCounts: [base.totalCount, candidate.totalCount],
    summaries,
    samples,
  };
  writeFileSync(values.output, JSON.stringify(result, null, 2), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output: values.output, summaries })}\n`);
} finally {
  for (const client of clients) {
    client.close();
  }
}
