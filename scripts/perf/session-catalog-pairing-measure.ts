// Real built Gateway proof for committed pairing updates followed by sessions.catalog.list.
// node --import ./scripts/tsx.mjs scripts/perf/session-catalog-pairing-measure.ts \
//   --entry /checkout/dist/entry.js --state-dir /fresh/synthetic-state --port 41842 --operations 200
// Run each revision with a new state directory. This single-client owner-flow proof is not a
// sustained Gateway stress test. Raw Prometheus snapshots retain handler/stage CPU and GC metrics;
// histogram percentile upper bounds are distinct from exact client wall-time percentiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionsCatalogListResult } from "../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string" },
    "state-dir": { type: "string" },
    operations: { type: "string", default: "200" },
    port: { type: "string", default: "41842" },
  },
});
assert(values.entry && values["state-dir"], "Supply --entry and a new --state-dir");
const entry = path.resolve(values.entry);
assert(
  entry.endsWith(".js") && statSync(entry).isFile(),
  "--entry must be a built JavaScript entry",
);
const stateDir = path.resolve(values["state-dir"]);
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "--port",
  min: 40000,
  fallback: 41842,
});
assert(port <= 65535, "--port must be at most 65535");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 200,
});
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) => {
  probe.close((error) => (error ? reject(error) : resolve()));
});

const fixture = await generateTeamShapeFixture(
  parseTeamShapeOptions([
    "--state-dir",
    stateDir,
    "--port",
    String(port),
    "--sessions",
    "10000",
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--transcript-mib",
    "1",
  ]),
);
const previousEnv = process.env;
try {
  process.env = { ...fixture.env };
  const [database, store, identities] = await Promise.all([
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/infra/device-pairing-store.js"),
    import("../../src/infra/device-identity-async.js"),
  ]);
  const devices: PairedDevice[] = Array.from({ length: 64 }, (_, index) => ({
    deviceId: `synthetic-node-${index}`,
    publicKey: `synthetic-public-key-${index}`,
    displayName: `Synthetic node ${index}`,
    platform: "linux",
    roles: ["node"],
    tokens: {
      node: { token: `synthetic-token-${index}`, role: "node", scopes: [], createdAtMs: 1 },
    },
    nodeSurface: {
      caps: ["canvas"],
      commands: ["system.run"],
      createdAtMs: 1,
      approvedAtMs: index + 1,
    },
    createdAtMs: 1,
    approvedAtMs: index + 1,
  }));
  try {
    store.persistDevicePairingStoreState(
      {
        pendingById: {},
        pairedByDeviceId: Object.fromEntries(devices.map((device) => [device.deviceId, device])),
      },
      stateDir,
      "both",
    );
    // Avoid measuring repeated optional identity misses in this pairing-publication workload.
    await identities.loadOrCreateDeviceIdentityAsync({ env: fixture.env });
  } finally {
    await database.closeOpenClawStateDatabaseAsync();
  }
} finally {
  process.env = previousEnv;
}

const catalogId = "synthetic-pairing-catalog";
const pluginDir = path.join(stateDir, catalogId);
mkdirSync(pluginDir);
writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: catalogId,
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
writeFileSync(
  path.join(pluginDir, "index.mjs"),
  `export default {
  id: '${catalogId}', register(api) {
    api.registerSessionCatalog({ id: '${catalogId}', label: 'Synthetic pairing catalog',
      audience: 'gateway-operators', supportsProcessHomeIsolation: true,
      list: async (query) => {
        const { nodes } = await query.listNodes();
        return nodes.map((node) => ({ hostId: 'node:' + node.nodeId, nodeId: node.nodeId,
          label: node.displayName ?? node.nodeId, kind: 'node', connected: node.connected,
          sessions: [] }));
      },
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    });
  },
};\n`,
);
const plugins = writePluginFixtures(stateDir, { count: 38 });
const configPath = path.join(stateDir, "openclaw.json");
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
config.diagnostics = { enabled: true };
config.session = { maintenance: { maxEntries: 20000 } };
config.plugins = {
  enabled: true,
  allow: [catalogId, "diagnostics-prometheus", ...plugins.pluginIds],
  load: { paths: [pluginDir, plugins.pluginsDir] },
  entries: Object.fromEntries(
    [catalogId, "diagnostics-prometheus", ...plugins.pluginIds].map((id) => [
      id,
      { enabled: true },
    ]),
  ),
};
writeFileSync(configPath, JSON.stringify(config));
const env = {
  ...fixture.env,
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, {
    startupTrace: false,
    caseEnv: { OPENCLAW_STATE_DIR: stateDir, TMPDIR: path.join(stateDir, "tmp") },
  }),
};
const log = createWriteStream(path.join(stateDir, "gateway-child.log"));
const child = spawn(process.execPath, buildGatewayBenchChildArgs(entry, port), {
  cwd: path.dirname(path.dirname(entry)),
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.once("close", () => log.end());
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let cleanupPromise: Promise<void> | undefined;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    client?.close();
    await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2000 });
  })());
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
};
const hostLoad: { at: number; load: number[]; freeMemory: number }[] = [];
const sampleHost = () =>
  hostLoad.push({ at: Date.now(), load: os.loadavg(), freeMemory: os.freemem() });
async function scrape(name: string) {
  // Completed phase events drain asynchronously; keep scrape latency outside measured requests.
  await delay(250);
  const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `Prometheus scrape failed: ${response.status}`);
  const metrics = await response.text();
  writeFileSync(path.join(stateDir, `${name}.prom`), metrics);
}
try {
  const deadline = Date.now() + 180_000;
  for (;;) {
    assert(
      child.exitCode === null && child.signalCode === null,
      "Gateway exited; inspect gateway-child.log",
    );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        break;
      }
    } catch {
      /* Startup has not opened the listener yet. */
    }
    assert(Date.now() < deadline, "Gateway startup timed out; inspect gateway-child.log");
    await delay(250);
  }
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const call = async (method: string, params: unknown) => {
    const response = await client!.request(method, params, 60_000);
    assert(response.ok, `${method} failed: ${JSON.stringify(response.error)}`);
    return response.payload;
  };
  await call("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
    caps: [],
  });
  const catalog = async (renamed?: { index: number; name: string }) => {
    const started = performance.now();
    let requests = 0;
    let pendingResponses = 0;
    let firstResponseMs = 0;
    for (;;) {
      const result = (await call("sessions.catalog.list", {
        catalogId,
        agentId: "main",
      })) as SessionsCatalogListResult;
      const elapsedMs = performance.now() - started;
      if (++requests === 1) {
        firstResponseMs = elapsedMs;
      }
      assert.equal(result.catalogs.length, 1);
      const listed = result.catalogs[0]!;
      assert.equal(listed.id, catalogId);
      assert.equal(listed.error, undefined);
      assert(listed.hosts.length === 0 || listed.hosts.length === 64);
      pendingResponses += Number(Boolean(listed.pending));
      for (const host of listed.hosts) {
        assert.equal(host.error, undefined);
        assert.equal(host.sessions.length, 0);
        assert.equal(host.connected, false);
      }
      if (
        listed.hosts.length === 64 &&
        (!renamed ||
          listed.hosts.find((host) => host.nodeId === `synthetic-node-${renamed.index}`)?.label ===
            renamed.name)
      ) {
        return { elapsedMs, firstResponseMs, requests, pendingResponses };
      }
      // A prepared page may be pending while refresh runs. Keep the same query/cache identity.
      assert(elapsedMs < 60_000, "Catalog did not publish the committed node label");
      await delay(1);
    }
  };
  for (let index = 0; index < 20; index++) {
    await catalog();
  }
  await scrape("before");
  sampleHost();
  const warm: Awaited<ReturnType<typeof catalog>>[] = [];
  for (let index = 0; index < operations; index++) {
    warm.push(await catalog());
  }
  await scrape("warm");
  sampleHost();
  const committed: Awaited<ReturnType<typeof catalog>>[] = [];
  const rename: number[] = [];
  for (let index = 0; index < operations; index++) {
    const renamed = { index: index % 64, name: `Synthetic renamed ${index}` };
    const started = performance.now();
    await call("node.rename", {
      nodeId: `synthetic-node-${renamed.index}`,
      displayName: renamed.name,
    });
    rename.push(performance.now() - started);
    committed.push(await catalog(renamed));
  }
  await scrape("committed");
  sampleHost();
  const summarize = (samples: typeof warm) => ({
    currentLabel: distribution(samples.map((sample) => sample.elapsedMs)),
    firstResponse: distribution(samples.map((sample) => sample.firstResponseMs)),
    requests: samples.reduce((sum, sample) => sum + sample.requests, 0),
    pendingResponses: samples.reduce((sum, sample) => sum + sample.pendingResponses, 0),
    pollIntervalMs: 1,
  });
  const result = {
    scope:
      "built dev Gateway, one WebSocket client, 10000 synthetic sessions, 64 offline nodes and 40 plugins; no model turns or sustained stress",
    entry,
    node: process.version,
    operations,
    fixture: fixture.summary,
    warmCatalog: summarize(warm),
    afterCommitCatalog: summarize(committed),
    rename: distribution(rename),
    hostLoad,
    metrics: ["before.prom", "warm.prom", "committed.prom"],
    phaseEvidence:
      "Difference Prometheus stage/handler histograms between successive snapshots; selected stage CPU is not whole-Gateway CPU",
  };
  writeFileSync(path.join(stateDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
