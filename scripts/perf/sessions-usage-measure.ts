// Synthetic state only. Run with node --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import type { SessionsUsageResult } from "../../src/shared/usage-types.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41783" },
    rounds: { type: "string", default: "5" },
    projection: { type: "string", default: "overview" },
    "pause-ms": { type: "string", default: "1000" },
    "warmup-ms": { type: "string", default: "0" },
    "converge-ms": { type: "string", default: "600000" },
    "same-query": { type: "boolean", default: false },
    "reset-usage": { type: "boolean", default: false },
    "seed-usage": { type: "boolean", default: false },
    "cpu-profile-dir": { type: "string" },
    "owner-dir": { type: "string" },
    "sample-allocations": { type: "boolean", default: false },
  },
});
assert(values.root && values.output);
const root = path.resolve(values.root);
const port = Number(values.port);
const rounds = Number(values.rounds);
assert(Number.isInteger(port) && port >= 40000 && port <= 65535);
assert(Number.isInteger(rounds) && rounds > 0);
assert(values.projection === "overview" || values.projection === "detail");
const fixture: { format: string; sessionCount: number; agentDatabaseBytes: number; now: number } =
  JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "usage-measure-"));
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  TMPDIR: temporaryRoot,
  OPENCLAW_SKIP_CHANNELS: "1",
});
const config: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
config.gateway = {
  ...config.gateway,
  controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
};
config.agents = {
  ...config.agents,
  defaults: { ...config.agents?.defaults, model: "synthetic/model" },
};
writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
if (values["reset-usage"]) {
  assert(!values["seed-usage"], "choose one offline fixture operation");
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.js");
  const { readSessionCostUsageRollupRowsInDatabase } =
    await import("../../src/infra/session-cost-usage-cache.kernel.js");
  const { prepareSessionCostUsageRefreshLock } =
    await import("../../src/infra/session-cost-usage-cache.sqlite.js");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const lock = prepareSessionCostUsageRefreshLock("main", database.path);
  let removed = 0;
  try {
    assert(await lock.acquire(), "fixture usage refresh is still active");
    const rows = readSessionCostUsageRollupRowsInDatabase(database.db);
    await lock.pruneRows(rows);
    removed = rows.length;
  } finally {
    await lock.release();
    await closeOpenClawAgentDatabasesAsync();
    rmSync(temporaryRoot, { recursive: true });
  }
  console.log(`Reset ${removed} synthetic usage projections`);
  process.exit(0);
}
if (values["seed-usage"]) {
  const marker = path.join(root, "usage-measure-seeded.json");
  assert(!existsSync(marker), "fixture usage is already seeded");
  const {
    openOpenClawAgentDatabase,
    runOpenClawAgentWriteTransaction,
    closeOpenClawAgentDatabasesAsync,
  } = await import("../../src/state/openclaw-agent-db.js");
  const { getSessionKysely } =
    await import("../../src/config/sessions/session-accessor.sqlite-scope.js");
  const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
  const { appendTranscriptEventsInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const windows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select(["session_id", "session_key"]),
  ).rows;
  assert.equal(windows.length, fixture.sessionCount);
  for (let offset = 0; offset < windows.length; offset += 100) {
    runOpenClawAgentWriteTransaction(
      (opened) => {
        for (const row of windows.slice(offset, offset + 100)) {
          appendTranscriptEventsInTransaction(
            opened,
            { agentId: "main", sessionId: row.session_id, sessionKey: row.session_key },
            [
              {
                type: "message",
                id: `usage-measure-${row.session_id}`,
                timestamp: new Date(fixture.now).toISOString(),
                message: {
                  role: "assistant",
                  provider: "synthetic",
                  model: "model",
                  content: [{ type: "text", text: "Synthetic measured usage" }],
                  usage: { input: 100, output: 25, totalTokens: 125, cost: { total: 0.001 } },
                },
              },
            ],
          );
        }
      },
      { agentId: "main" },
    );
  }
  database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  await closeOpenClawAgentDatabasesAsync();
  writeFileSync(
    marker,
    JSON.stringify({
      sessions: windows.length,
      tokens: windows.length * 125,
      cost: windows.length * 0.001,
    }),
  );
  console.log(`Seeded usage for ${windows.length} synthetic sessions`);
  rmSync(temporaryRoot, { recursive: true });
  process.exit(0);
}
let ownerTimings: Array<{ owner: string; kind?: string; elapsedMs: number }> = [];
Reflect.set(globalThis, Symbol.for("usage-measure-timings"), ownerTimings);
const enteredOwners = new Set<string>();
Reflect.set(globalThis, Symbol.for("usage-measure-entered"), enteredOwners);
// Preserve source URLs and apply the same baseline to every database worker.
const preload = `${values.output}.preload.mjs`;
writeFileSync(
  preload,
  String.raw`
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
await import(${JSON.stringify(import.meta.resolve("tsx/esm"))});
const { transformSync } = await import(${JSON.stringify(import.meta.resolve("esbuild"))});
const repo = ${JSON.stringify(path.resolve("."))};
const baseline = ${JSON.stringify(values["owner-dir"] ? path.resolve(values["owner-dir"]) : null)};
const cpuProfileDir = ${JSON.stringify(values["cpu-profile-dir"] ? path.resolve(values["cpu-profile-dir"]) : null)};
const workerMetrics = ${JSON.stringify(`${values.output}.workers.jsonl`)};
const allocations = ${JSON.stringify(values["sample-allocations"])};
const owners = new Map([
  ["src/infra/session-cost-usage-worker-runtime.ts", "runUsageCostWorker"],
  ["src/infra/session-cost-usage-worker.ts", "executeUsageCostWorker"],
  ["src/gateway/server-methods/usage-session-selection.ts", "selectUsageSessions"],
]);
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  const relative = path.relative(repo, fileURLToPath(url));
  if (relative.startsWith("..")) return nextLoad(url, context);
  const replacement = baseline && path.join(baseline, relative);
  const owner = owners.get(relative);
  const workerArgs = cpuProfileDir && relative === "src/infra/runtime-worker-url.ts";
  if ((!replacement || !existsSync(replacement)) && !owner && !workerArgs) return nextLoad(url, context);
  let source = readFileSync(replacement && existsSync(replacement) ? replacement : fileURLToPath(url), "utf8");
  if (workerArgs) {
    source = source.replace("export function resolveRuntimeWorkerThreadExecArgv(", "function measuredWorkerArgs(");
    source += "\nexport function resolveRuntimeWorkerThreadExecArgv(...args) { return [...measuredWorkerArgs(...args), '--cpu-prof', " + JSON.stringify("--cpu-prof-dir=" + cpuProfileDir) + "]; }";
  }
  if (owner) {
    const original = "measured_" + owner;
    const declaration = "export async function " + owner + "(";
    if (!source.includes(declaration)) throw new Error("Measurement owner declaration changed: " + owner);
    source = source.replace(declaration, "async function " + original + "(");
    if (owner === "executeUsageCostWorker") {
      source += "\nexport async function executeUsageCostWorker(...args) { const profiler = new (await import('node:inspector/promises')).Session(); if (" + allocations + ") { profiler.connect(); await profiler.post('HeapProfiler.startSampling', {samplingInterval:32768, includeObjectsCollectedByMajorGC:true, includeObjectsCollectedByMinorGC:true}); } const cpu = process.threadCpuUsage(); const startedAt = Date.now(); const started = performance.now(); try { return await measured_executeUsageCostWorker(...args); } finally { const elapsedMs = performance.now() - started; const used = process.threadCpuUsage(cpu); let allocatedBytes; if (" + allocations + ") { const {profile} = await profiler.post('HeapProfiler.stopSampling'); const sum = node => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0); allocatedBytes = sum(profile.head); profiler.disconnect(); } const fs = await import('node:fs'); fs.appendFileSync(" + JSON.stringify(workerMetrics) + ", JSON.stringify({startedAt, kind:args[0].operation.kind, elapsedMs, cpuMs:(used.user+used.system)/1000, allocatedBytes}) + String.fromCharCode(10)); } }";
    } else source += "\nexport async function " + owner + "(...args) { const timings = globalThis[Symbol.for('usage-measure-timings')]; globalThis[Symbol.for('usage-measure-entered')]?.add('" + owner + "'); const started = performance.now(); try { return await " + original + "(...args); } finally { timings?.push({owner: '" + owner + "', kind: args[1]?.kind, elapsedMs: performance.now() - started}); } }";
  }
  return { format: "module", source: transformSync(source, { loader: "ts", format: "esm", target: "esnext", sourcefile: fileURLToPath(url) }).code, shortCircuit: true };
}});
`,
);
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS,
  `--import=${JSON.stringify(pathToFileURL(preload).href)}`,
]
  .filter(Boolean)
  .join(" ");
await import(pathToFileURL(preload).href);
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { createGatewayWsClient } = await import("../lib/gateway-ws-client.ts");
const { PROTOCOL_VERSION } = await import("../../packages/gateway-protocol/src/version.ts");
const { buildDeviceAuthPayloadV3 } =
  await import("../../packages/gateway-client/src/device-auth.ts");
const { publicKeyRawBase64UrlFromEd25519Pem, signEd25519Payload } =
  await import("../../src/infra/ed25519-signature.ts");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
const peer = createGatewayWsClient({
  url: `ws://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  onEvent(event) {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (
      event.event === "connect.challenge" &&
      typeof payload?.nonce === "string" &&
      typeof payload.ts === "number"
    ) {
      challenge.resolve({ nonce: payload.nonce, ts: payload.ts });
    }
  },
});
async function rpc(method: string, params: unknown) {
  const response = await peer.request(method, params, 120_000);
  assert(response.ok, JSON.stringify(response.error));
  return response.payload;
}
const samples: Array<{
  round: number;
  startedAt: number;
  ownerTimings: typeof ownerTimings;
  elapsedMs: number;
  processCpuMs: number;
  mainThreadCpuMs: number;
  mainThreadAllocatedBytes?: number;
  heapDeltaBytes: number;
  rssBytes: number;
  responseBytes: number;
  cacheStatus: SessionsUsageResult["cacheStatus"];
  partial: SessionsUsageResult["partial"];
  totals: SessionsUsageResult["totals"];
}> = [];
const inspector = new Session();
if (values["sample-allocations"]) {
  inspector.connect();
}
try {
  await peer.waitOpen();
  const { nonce, ts } = await challenge.promise;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const client = {
    id: "openclaw-control-ui",
    version: "dev",
    platform: "web",
    mode: "webchat",
    instanceId: "usage-measure",
  };
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  const signed = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: client.id,
    clientMode: client.mode,
    platform: client.platform,
    role: "operator",
    scopes,
    signedAtMs: ts,
    nonce,
  });
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: "operator",
    scopes,
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        signed,
      ),
    },
    caps: [],
  });
  await delay(Number(values["warmup-ms"]));
  const convergenceStarted = performance.now();
  const convergenceCpu = process.cpuUsage();
  let lastResult: SessionsUsageResult | undefined;
  const complete = () =>
    lastResult?.cacheStatus?.status === "fresh" &&
    lastResult.cacheStatus.pendingFiles === 0 &&
    !lastResult.partial;
  const assertTotals = (result: SessionsUsageResult) => {
    if (existsSync(path.join(root, "usage-measure-seeded.json"))) {
      assert.equal(result.totals.totalTokens, fixture.sessionCount * 125);
      assert(Math.abs(result.totals.totalCost - fixture.sessionCount * 0.001) < 1e-8);
    }
  };
  for (let round = 0; round < rounds; round++) {
    if (values["sample-allocations"]) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    ownerTimings = [];
    Reflect.set(globalThis, Symbol.for("usage-measure-timings"), ownerTimings);
    enteredOwners.clear();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const startedAt = Date.now();
    const started = performance.now();
    const result = (await rpc("sessions.usage", {
      agentId: "main",
      startDate: new Date(Date.UTC(2026, 8, 1 + (values["same-query"] ? 0 : round)))
        .toISOString()
        .slice(0, 10),
      endDate: "2026-10-30",
      ...(values.projection === "overview" ? { projection: "overview" } : {}),
      limit: 50,
    })) as SessionsUsageResult;
    const elapsedMs = performance.now() - started;
    lastResult = result;
    if (!values["same-query"]) {
      assert(enteredOwners.has("selectUsageSessions"), "sample reused the outer report cache");
    }
    if (complete()) {
      assertTotals(result);
    }
    const used = process.cpuUsage(cpu);
    const threadUsed = process.threadCpuUsage(threadCpu);
    let mainThreadAllocatedBytes: number | undefined;
    if (values["sample-allocations"]) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      mainThreadAllocatedBytes = sumSampledHeapBytes(profile.head);
      writeFileSync(`${values.output}.round-${round}.heapprofile`, JSON.stringify(profile));
    }
    const after = process.memoryUsage();
    const sample = {
      round,
      startedAt,
      enteredOwners: [...enteredOwners],
      ownerTimings: [...ownerTimings],
      elapsedMs,
      processCpuMs: (used.user + used.system) / 1000,
      mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
      mainThreadAllocatedBytes,
      heapDeltaBytes: after.heapUsed - memory.heapUsed,
      rssBytes: after.rss,
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
      cacheStatus: result.cacheStatus,
      partial: result.partial,
      totals: result.totals,
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
    writeFileSync(
      values.output,
      JSON.stringify(
        { fixture, node: process.version, projection: values.projection, load: loadavg(), samples },
        null,
        2,
      ),
    );
    if (round + 1 < rounds) {
      await delay(Number(values["pause-ms"]));
    }
  }
  const polls: Array<{ elapsedMs: number; pendingFiles?: number; tokens: number }> = [];
  while (!complete() && performance.now() - convergenceStarted < Number(values["converge-ms"])) {
    await delay(5_000);
    lastResult = (await rpc("sessions.usage", {
      agentId: "main",
      startDate: "2026-09-01",
      endDate: "2026-10-30",
      ...(values.projection === "overview" ? { projection: "overview" } : {}),
      limit: 50,
    })) as SessionsUsageResult;
    polls.push({
      elapsedMs: performance.now() - convergenceStarted,
      pendingFiles: lastResult.cacheStatus?.pendingFiles,
      tokens: lastResult.totals.totalTokens,
    });
    console.log(JSON.stringify({ convergence: polls.at(-1) }));
  }
  const totalCpu = process.cpuUsage(convergenceCpu);
  const convergence = {
    complete: complete(),
    elapsedMs: performance.now() - convergenceStarted,
    processCpuMs: (totalCpu.user + totalCpu.system) / 1000,
    polls,
    totals: lastResult?.totals,
    cacheStatus: lastResult?.cacheStatus,
  };
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        fixture,
        node: process.version,
        projection: values.projection,
        load: loadavg(),
        samples,
        convergence,
      },
      null,
      2,
    ),
  );
  assert(
    convergence.complete,
    "usage did not converge to complete recorded totals within the deadline",
  );
  assertTotals(lastResult!);
} finally {
  inspector.disconnect();
  peer.close();
  await server.close({ reason: "synthetic usage measurement complete" });
  rmSync(temporaryRoot, { recursive: true });
}
