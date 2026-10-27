// Real SQLite model-context owner, with synthetic user/tool turns and bounded reads.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-model-context-measure.ts \
//   --output .local/context-candidate --mode timing --iterations 2000
// Add --owner-file .local/context-base.ts to substitute the exact baseline owner.
// Run timing and allocation separately, counterbalancing base/candidate order.
// --sessions 1 measures a warm navigation cache; the default 16 rotates transcripts.
// Cold admitted suffix: --prefix-events 47000 --fenced --turns 30 --sessions 2
//   --iterations 10 --max-navigation-rows 125. Pair --owner-file with --pages-file
//   to substitute both immutable baseline owners.
// Acceptance: identical event bytes/counts, less allocation, no material CPU regression.
// This is owner evidence, not a whole-Gateway load test. Fixture setup is excluded.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
  const exitCode = await new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  process.exit(exitCode);
}

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    "pages-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    sessions: { type: "string", default: "16" },
    turns: { type: "string", default: "64" },
    "prefix-events": { type: "string", default: "0" },
    boundary: { type: "string", default: "reset" },
    "max-navigation-rows": { type: "string" },
    fenced: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required and must be a new directory");
assert(!values["pages-file"] || values["owner-file"], "--pages-file requires --owner-file");
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
const iterations = Number(values.iterations);
const sessions = Number(values.sessions);
const turns = Number(values.turns);
const prefixEvents = Number(values["prefix-events"]);
assert(Number.isSafeInteger(prefixEvents) && prefixEvents >= 0);
assert(values.boundary === "reset" || values.boundary === "compaction");
for (const count of [iterations, sessions, turns]) {
  assert(Number.isSafeInteger(count) && count > 0, "Counts must be positive safe integers");
}
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(output);
const env = {
  PATH: process.env.PATH,
  HOME: path.join(output, "home"),
  OPENCLAW_HOME: path.join(output, "home"),
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  TMPDIR: path.join(output, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
for (const directory of [env.HOME, env.OPENCLAW_STATE_DIR, env.TMPDIR]) {
  mkdirSync(directory, { recursive: true });
}
Object.assign(process.env, env);
const ownerUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-model-context.ts",
  import.meta.url,
);
const sourceUrl = values["owner-file"]
  ? pathToFileURL(path.resolve(values["owner-file"]))
  : ownerUrl;
const ownerSha256 = hash("sha256", readFileSync(sourceUrl));
const pagesUrl = new URL(
  "../../src/config/sessions/session-model-context-pages.ts",
  import.meta.url,
);
const pagesSourceUrl = values["pages-file"]
  ? pathToFileURL(path.resolve(values["pages-file"]))
  : pagesUrl;
const pagesSha256 = hash("sha256", readFileSync(pagesSourceUrl));
let ownerLoaded = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href || (values["pages-file"] && url === pagesUrl.href)) {
        ownerLoaded ||= url === ownerUrl.href;
        const loaded = nextLoad(
          url === ownerUrl.href ? sourceUrl.href : pagesSourceUrl.href,
          context,
        );
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const statementSql = new WeakMap<StatementSync, string>();
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the live receiver with apply and restores the original method.
const originalPrepare = DatabaseSync.prototype.prepare;
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the live receiver with apply and restores the original method.
const originalIterate = StatementSync.prototype.iterate;
let navigationRows = 0;
let countNavigation = false;
DatabaseSync.prototype.prepare = function (...parameters) {
  const statement = originalPrepare.apply(this, parameters);
  const query = parameters[0];
  statementSql.set(statement, query);
  return statement;
};
StatementSync.prototype.iterate = new Proxy(originalIterate, {
  apply(target, receiver: StatementSync, bindings) {
    const iterator: ReturnType<typeof originalIterate> = Reflect.apply(target, receiver, bindings);
    if (!statementSql.get(receiver)?.includes('as "navigation_json"')) {
      return iterator;
    }
    return (function* () {
      for (const row of iterator) {
        if (countNavigation) {
          navigationRows++;
        }
        yield row;
      }
      return undefined;
    })();
  },
});
const { readSessionTranscriptModelContext: read } =
  await import("../../src/config/sessions/session-accessor.sqlite-model-context.js");
assert(!values["owner-file"] || ownerLoaded, "Baseline owner substitution was not loaded");
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const { resolveOpenClawAgentSqlitePath, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
const scopes = Array.from({ length: sessions }, (_, index) => ({
  agentId: "main",
  sessionId: `synthetic-context-${index}`,
  sessionKey: `agent:main:synthetic-context-${index}`,
  storePath,
  env,
}));
const timestamp = "2026-10-25T00:00:00.000Z";
const text = 'synthetic 🦞 "file"\\path\n'.repeat(16);
function events(sessionId: string): TranscriptEvent[] {
  const result: TranscriptEvent[] = [
    { type: "session", version: 3, id: sessionId, cwd: "/synthetic", timestamp },
  ];
  let parentId: string | null = null;
  for (let index = 0; index < prefixEvents; index++) {
    const id = `old-${index}`;
    result.push({
      type: "message",
      id,
      parentId,
      timestamp,
      message: { role: "user", content: text, timestamp: index },
    });
    parentId = id;
  }
  if (prefixEvents) {
    const id = "context-boundary";
    result.push(
      values.boundary === "reset"
        ? { type: "reset", id, parentId, timestamp, reason: "new" }
        : {
            type: "compaction",
            id,
            parentId,
            timestamp,
            summary: "Synthetic summary",
            tokensBefore: prefixEvents,
            firstKeptEntryId: id,
          },
    );
    parentId = id;
  }
  for (let turn = 0; turn < turns; turn++) {
    const messages = [
      { role: "user", content: `Question ${turn}: ${text}`, timestamp: turn },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: "synthetic" } },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "synthetic",
        stopReason: "toolUse",
        timestamp: turn,
      },
      {
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: turn,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${turn}: ${text}` }],
        api: "openai-responses",
        provider: "openai",
        model: "synthetic",
        stopReason: "stop",
        timestamp: turn,
      },
    ];
    for (const message of messages) {
      const id = `entry-${result.length}`;
      result.push({ type: "message", id, parentId, timestamp, message });
      parentId = id;
    }
  }
  if (values.fenced) {
    result.push({
      type: "message",
      id: "admitted-user",
      parentId,
      timestamp,
      message: { role: "user", content: "Current synthetic turn", timestamp: turns },
    });
  }
  return result;
}
const { readActiveTranscriptEntryAnchor } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-admitted-read.js");
const { runWithSessionTranscriptReadFence } =
  await import("../../src/config/sessions/session-transcript-read-fence.js");
const admissions = new Map<
  string,
  NonNullable<ReturnType<typeof readActiveTranscriptEntryAnchor>>
>();
const readContext = (scope: (typeof scopes)[number]) => {
  const anchor = admissions.get(scope.sessionId);
  return anchor
    ? runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "synthetic-turn", role: "user" },
        () => read(scope, undefined, limits),
      )
    : read(scope, undefined, limits);
};
const limits = prefixEvents
  ? { maxBytes: 8 * 1024 * 1024, maxEvents: 10_000 }
  : { maxBytes: 1024 * 1024, maxEvents: 128 };
const inspector = new Session();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    pauses.push(entry.duration);
  }
});
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
try {
  await importSqliteSessionRowsBatch(
    scopes.map((scope) => ({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      transcriptMtimeMs: 1,
      readTranscriptEvents: (append) => {
        for (const event of events(scope.sessionId)) {
          append(event);
        }
      },
    })),
  );
  if (values.fenced) {
    for (const scope of scopes) {
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted-user" });
      assert(anchor);
      admissions.set(scope.sessionId, anchor);
    }
  }
  let latest = readContext(scopes[0]!);
  const golden = JSON.stringify(latest.events);
  for (let index = 0; index < (prefixEvents ? sessions : 32); index++) {
    readContext(scopes[index % sessions]!);
  }
  await setImmediate();
  observer.observe({ entryTypes: ["gc"] });
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  countNavigation = true;
  const loadBefore = os.loadavg();
  const beforeCpu = process.threadCpuUsage();
  const started = performance.now();
  let eventCount = 0;
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const sampleStart = performance.now();
    latest = readContext(scopes[index % sessions]!);
    samples.push(performance.now() - sampleStart);
    eventCount += latest.events.length;
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(beforeCpu);
  DatabaseSync.prototype.prepare = originalPrepare;
  StatementSync.prototype.iterate = originalIterate;
  const sampled =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  assert.equal(JSON.stringify(readContext(scopes[0]!).events), golden);
  const result = {
    mode: values.mode,
    node: process.version,
    isMainThread,
    threadId,
    iterations,
    sessions,
    turns,
    prefixEvents,
    fenced: values.fenced,
    boundary: values.boundary,
    navigationRows,
    limits,
    ownerSha256,
    pagesSha256,
    eventCount,
    eventsPerRead: latest.events.length,
    firstSessionEventBytes: Buffer.byteLength(golden),
    firstSessionEventSha256: hash("sha256", golden),
    samples,
    medianMs: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
    p95Ms: samples.toSorted((a, b) => a - b)[
      Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)
    ],
    wallMs: values.mode === "timing" ? wallMs : undefined,
    cpuMs: values.mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
    cpuUsPerRead: values.mode === "timing" ? (cpu.user + cpu.system) / iterations : undefined,
    allocatedBytes: sampled ? allocatedBytes(sampled.profile.head) : undefined,
    allocatedBytesPerRead: sampled ? allocatedBytes(sampled.profile.head) / iterations : undefined,
    gcMs: values.mode === "timing" ? pauses.reduce((sum, pause) => sum + pause, 0) : undefined,
    gcCount: values.mode === "timing" ? pauses.length : undefined,
    gcMaxMs: values.mode === "timing" ? Math.max(0, ...pauses) : undefined,
    memory: process.memoryUsage(),
    loadBefore,
    loadAfter: os.loadavg(),
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (sampled) {
    writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(sampled.profile));
  }
  console.log(JSON.stringify(result));
  if (values["max-navigation-rows"]) {
    assert(
      navigationRows / iterations <= Number(values["max-navigation-rows"]),
      `Navigation read exceeded budget: ${navigationRows / iterations} rows/read`,
    );
  }
} finally {
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
