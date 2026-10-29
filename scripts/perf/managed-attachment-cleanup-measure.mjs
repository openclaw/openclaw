// Synthetic managed-media maintenance; run only inside an owned performance sandbox.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: process.cwd() },
    "state-dir": { type: "string" },
    output: { type: "string" },
    prepare: { type: "boolean" },
    allocations: { type: "boolean" },
    "owner-dir": { type: "string" },
    messages: { type: "string", default: "5000" },
    "message-bytes": { type: "string", default: "8192" },
    operations: { type: "string", default: "30" },
    seconds: { type: "string", default: "30" },
    "start-at": { type: "string" },
    "trace-log": { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const sourceRoot = path.resolve(values["source-root"]);
const stateDir = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const integer = (value, name, min = 1) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number >= min, `Invalid ${name}`);
  return number;
};
const messageCount = integer(values.messages, "messages");
const messageBytes = integer(values["message-bytes"], "message-bytes");
const operations = integer(values.operations, "operations");
const seconds = integer(values.seconds, "seconds");
const marker = path.join(stateDir, "attachment-cleanup-fixture.json");
mkdirSync(path.dirname(output), { recursive: true });
if (values.prepare) {
  assert(!existsSync(stateDir), "--prepare requires a fresh synthetic state directory");
  mkdirSync(stateDir);
} else {
  assert(existsSync(marker), "Refusing state without the synthetic cleanup fixture marker");
}
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = path.join(stateDir, "home");
process.env.HOME = process.env.OPENCLAW_HOME;
process.env.TMPDIR = path.join(stateDir, "tmp");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.TMPDIR, { recursive: true });
const traceLog = values["trace-log"] && path.resolve(values["trace-log"]);
const markGc = (phase) => {
  if (traceLog) {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath: output })}\n`,
    );
  }
};
if (traceLog) {
  assert(!values.prepare, "--trace-log applies only to measurement");
  assert(
    process.execArgv.includes("--trace-gc-nvp") && typeof global.gc === "function",
    "--trace-log requires --expose-gc --trace-gc-nvp",
  );
  // Identify before importing owners that launch workers; never collect inside the workload.
  markGc("identify-start");
  global.gc();
  markGc("identify-stop");
}
const source = (name) => import(pathToFileURL(path.join(sourceRoot, name)).href);
let overrideReceipt;
if (values["owner-dir"]) {
  const files = [
    "src/gateway/managed-image-attachments.ts",
    "src/gateway/session-transcript-read.types.ts",
    "src/gateway/session-transcript-archive-reader.ts",
    "src/config/sessions/session-accessor.sqlite-history-source.ts",
    "src/config/sessions/session-actor-memory-history-projection.ts",
  ];
  const replacements = Object.fromEntries(
    files.map((file) => [
      pathToFileURL(path.join(sourceRoot, file)).href,
      path.join(path.resolve(values["owner-dir"]), file),
    ]),
  );
  for (const file of Object.values(replacements)) {
    assert(existsSync(file), `Missing selected owner ${file}`);
  }
  const preload = `${output}.owner-preload.cjs`;
  overrideReceipt = `${output}.owners-loaded.jsonl`;
  assert(!existsSync(overrideReceipt), "Owner receipt already exists");
  writeFileSync(
    preload,
    `const { registerHooks } = require('node:module');
const { transformSync } = require(require.resolve('esbuild', { paths: [${JSON.stringify(sourceRoot)}] }));
const { readFileSync, appendFileSync } = require('node:fs');
const { threadId } = require('node:worker_threads');
const replacements = ${JSON.stringify(replacements)};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const filename = replacements[url];
  if (filename) {
    loaded.source = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'esm', target: 'esnext', sourcefile: filename }).code;
    appendFileSync(${JSON.stringify(overrideReceipt)}, JSON.stringify({ threadId, owner: url.slice(${pathToFileURL(sourceRoot + path.sep).href.length}) }) + '\\n');
  }
  return loaded;
} });\n`,
    { flag: "wx" },
  );
  // NODE_OPTIONS covers workers that replace execArgv; install the same hook in this isolate.
  process.env.NODE_OPTIONS =
    `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim();
  createRequire(import.meta.url)(preload);
}
const config = await source("src/config/config.ts");
const sessions = await source("src/config/sessions/session-accessor.ts");
const media = await source("src/gateway/managed-image-attachments.ts");
const records = await source("src/gateway/managed-image-record-store.ts");
const agentDatabase = await source("src/state/openclaw-agent-db.ts");
const stateDatabase = await source("src/state/openclaw-state-db.ts");
const metrics = await source("src/infra/worker-message-metrics.ts");
config.setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
const scope = {
  agentId: "main",
  sessionId: "synthetic-attachment-cleanup",
  sessionKey: "agent:main:synthetic-attachment-cleanup",
  storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
};
let inspector;
try {
  if (values.prepare) {
    assert(
      sessions.ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() }),
    );
    const filePath = path.join(stateDir, "synthetic-attachment.txt");
    writeFileSync(filePath, "Synthetic attachment bytes\n", { flag: "wx" });
    const attachments = [];
    for (let index = 0; index < 2; index++) {
      const messageId = `attachment-${index}`;
      const blocks = await media.createManagedOutgoingMediaBlocks({
        sessionKey: scope.sessionKey,
        agentId: "main",
        stateDir,
        messageId,
        items: [
          { url: filePath, filename: "synthetic.txt", mimeType: "text/plain", trustedLocal: true },
        ],
        localRoots: [stateDir],
      });
      assert(blocks.length, "Managed attachment creation returned no blocks");
      attachments.push({ messageId, blocks });
    }
    const timestamp = "2026-10-23T00:00:00.000Z";
    const events = [
      { type: "session", version: 3, id: scope.sessionId, cwd: stateDir, timestamp },
      ...Array.from({ length: messageCount }, (_, index) => ({
        type: "message",
        timestamp,
        id: `message-${index}`,
        parentId: index ? `message-${index - 1}` : null,
        message: {
          role: "assistant",
          content: `${String(index).padStart(8, "0")}${"x".repeat(Math.max(0, messageBytes - 8))}`,
        },
      })),
      ...attachments.map(({ messageId, blocks }, index) => ({
        type: "message",
        timestamp,
        id: messageId,
        parentId: index ? "attachment-0" : `message-${messageCount - 1}`,
        message: { role: "assistant", content: blocks },
      })),
    ];
    const writer = await source(
      "src/config/sessions/session-accessor.sqlite-transcript-write.test-support.ts",
    );
    await writer.replaceTranscriptEvents(scope, events);
    await sessions.waitForSessionTranscriptProjection(scope);
    const fixture = {
      format: "openclaw-managed-cleanup-v1",
      messageCount,
      messageBytes,
      attachments: 2,
      sessionKey: scope.sessionKey,
    };
    writeFileSync(marker, JSON.stringify(fixture), { flag: "wx" });
    writeFileSync(output, JSON.stringify({ prepared: true, fixture }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ prepared: true, fixture }));
  } else {
    const fixture = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(fixture.format, "openclaw-managed-cleanup-v1");
    const cleanup = () =>
      media.cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: scope.sessionKey });
    await cleanup();
    assert.equal(
      (await records.listManagedImageRecordEntries({ stateDir, sessionKey: scope.sessionKey }))
        .length,
      2,
    );
    inspector = values.allocations ? new Session() : undefined;
    inspector?.connect();
    if (inspector) {
      await inspector.post("HeapProfiler.enable");
    }
    const gc = new GCProfiler();
    const loop = monitorEventLoopDelay({ resolution: 1 });
    if (values["start-at"]) {
      const wait = integer(values["start-at"], "start-at") - Date.now();
      assert(wait > 0, "Missed shared --start-at; discard and rerun the pair");
      await delay(wait);
    }
    if (inspector) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const before = process.memoryUsage();
    const messagesBefore = metrics.getWorkerMessageMetrics();
    const cpuBefore = process.cpuUsage();
    const threadBefore = process.threadCpuUsage();
    gc.start();
    loop.enable();
    markGc("diagnostics-start");
    const startedAtEpochMs = Date.now();
    const start = performance.now();
    const latencies = [];
    for (let index = 0; index < operations; index++) {
      const at = performance.now();
      await cleanup();
      latencies.push(performance.now() - at);
      const wait = start + ((index + 1) / operations) * seconds * 1000 - performance.now();
      if (wait > 0) {
        await delay(wait);
      }
    }
    const elapsedMs = performance.now() - start;
    markGc("diagnostics-stop");
    const threadCpu = process.threadCpuUsage(threadBefore);
    const cpu = process.cpuUsage(cpuBefore);
    loop.disable();
    const collections = gc.stop()?.statistics ?? [];
    const after = process.memoryUsage();
    const workerMessages = metrics
      .getWorkerMessageMetrics()
      .map((row) => {
        const prior = messagesBefore.find(
          (value) => value.kind === row.kind && value.direction === row.direction,
        );
        return Object.assign(row, {
          messages: row.messages - (prior?.messages ?? 0),
          payloadBytes: row.payloadBytes - (prior?.payloadBytes ?? 0),
          unmeasuredMessages: row.unmeasuredMessages - (prior?.unmeasuredMessages ?? 0),
        });
      })
      .filter((row) => row.messages > 0);
    let allocation;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const nodes = [profile.head];
      let bytes = 0;
      const native = [];
      for (const node of nodes) {
        bytes += node.selfSize;
        if (node.callFrame.scriptId === "0" && node.callFrame.url === "" && node.selfSize) {
          native.push({ name: node.callFrame.functionName, selfBytes: node.selfSize });
        }
        nodes.push(...node.children);
      }
      allocation = {
        bytes,
        bytesPerOperation: bytes / operations,
        samples: profile.samples.length,
        native,
      };
      writeFileSync(`${output}.heapprofile`, JSON.stringify(profile), { flag: "wx" });
    }
    const tails = (input) => {
      const sorted = input.toSorted((a, b) => a - b);
      const percentile = (p) => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : 0);
      return {
        count: sorted.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: sorted.at(-1) ?? 0,
        totalMs: sorted.reduce((a, b) => a + b, 0),
      };
    };
    const gcByKind = Object.fromEntries(
      [...new Set(collections.map((row) => row.gcType))].map((kind) => [
        kind,
        tails(collections.filter((row) => row.gcType === kind).map((row) => row.cost / 1000)),
      ]),
    );
    const totalGc = tails(collections.map((row) => row.cost / 1000));
    assert.equal(
      (await records.listManagedImageRecordEntries({ stateDir, sessionKey: scope.sessionKey }))
        .length,
      2,
      "Cleanup removed a referenced original",
    );
    const report = {
      fixture,
      node: process.version,
      operations,
      requestedSeconds: seconds,
      startedAtEpochMs,
      elapsedMs,
      latency: tails(latencies),
      cpuMs: (cpu.user + cpu.system) / 1000,
      mainCpuMs: (threadCpu.user + threadCpu.system) / 1000,
      gc: { ...totalGc, msPerOperation: totalGc.totalMs / operations, byKind: gcByKind },
      eventLoop: {
        count: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
      allocation,
      before,
      after,
      workerMessages,
      promotion: traceLog ? readGatewayGcTrace(traceLog, output, "diagnostics") : undefined,
      workerByteLimit:
        "Known payload bytes only; unmeasuredMessages are retained. No reserialization observer.",
      overriddenOwners: overrideReceipt
        ? readFileSync(overrideReceipt, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : undefined,
    };
    writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(JSON.stringify(report));
  }
} finally {
  if (inspector) {
    await inspector.post("HeapProfiler.disable").catch(() => {});
    inspector.disconnect();
  }
  await agentDatabase.closeOpenClawAgentDatabasesAsync();
  await stateDatabase.closeOpenClawStateDatabaseAsync();
  config.clearRuntimeConfigSnapshot();
}
