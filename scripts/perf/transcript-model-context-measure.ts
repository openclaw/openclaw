// Real SQLite model-context owner, with synthetic user/tool turns and bounded reads.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-model-context-measure.ts \
//   --output .local/context-candidate --mode timing --iterations 2000
// Add --owner-file .local/context-base.ts to substitute the exact baseline owner.
// --navigation-owner-file substitutes only the navigation owner for cache comparisons.
// --mode navigation counts actual SQLite navigation work and samples retained process heap.
// Use --sessions 2 for alternating hits and --sessions 16 for bounded-eviction evidence.
// Run timing and allocation separately, counterbalancing base/candidate order.
// --sessions 1 measures a warm navigation cache; the default 16 rotates transcripts.
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
import type { SQLInputValue } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    "navigation-owner-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    sessions: { type: "string", default: "16" },
    turns: { type: "string", default: "64" },
  },
});
assert(values.output, "--output is required and must be a new directory");
assert(["timing", "allocation", "navigation"].includes(values.mode), "Invalid --mode");
const iterations = Number(values.iterations);
const sessions = Number(values.sessions);
const turns = Number(values.turns);
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
const navigationUrl = new URL(
  "../../src/config/sessions/session-model-context-pages.ts",
  import.meta.url,
);
const navigationSourceUrl = values["navigation-owner-file"]
  ? pathToFileURL(path.resolve(values["navigation-owner-file"]))
  : navigationUrl;
let ownerLoaded = false;
let navigationLoaded = false;
if (values["owner-file"] || values["navigation-owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (values["owner-file"] && url === ownerUrl.href) {
        ownerLoaded = true;
        const loaded = nextLoad(sourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      if (values["navigation-owner-file"] && url === navigationUrl.href) {
        navigationLoaded = true;
        const loaded = nextLoad(navigationSourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { readSessionTranscriptModelContext: read } =
  await import("../../src/config/sessions/session-accessor.sqlite-model-context.js");
assert(!values["owner-file"] || ownerLoaded, "Baseline owner substitution was not loaded");
assert(
  !values["navigation-owner-file"] || navigationLoaded,
  "Baseline navigation substitution was not loaded",
);
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
  return result;
}
const limits = { maxBytes: 1024 * 1024, maxEvents: 128 };
const inspector = new Session();
const navigation = { queries: 0, fullQueries: 0, rows: 0 };
let restoreSqlObserver: (() => void) | undefined;
async function retainedMemory() {
  if (values.mode !== "navigation") {
    return undefined;
  }
  await inspector.post("HeapProfiler.collectGarbage");
  return process.memoryUsage();
}
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
  if (values.mode === "navigation") {
    inspector.connect();
    const { DatabaseSync } = await import("node:sqlite");
    // oxlint-disable-next-line typescript/unbound-method -- The observer forwards each call with its original database receiver.
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/as "navigation_json"/i.test(sql) && /from "transcript_events"/i.test(sql)) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* (
          first?: SQLInputValue | Record<string, SQLInputValue>,
          ...parameters: SQLInputValue[]
        ) {
          navigation.queries++;
          navigation.fullQueries += first === -1 || parameters.includes(-1) ? 1 : 0;
          // Preserve both native overloads: named bindings and positional bindings.
          const rows = (() => {
            if (first === undefined) {
              return iterate(...parameters);
            }
            if (typeof first === "object" && first !== null && !ArrayBuffer.isView(first)) {
              return iterate(first, ...parameters);
            }
            return iterate(first, ...parameters);
          })();
          for (const row of rows) {
            navigation.rows++;
            yield row;
          }
          return undefined;
        };
      }
      return statement;
    };
    restoreSqlObserver = () => {
      DatabaseSync.prototype.prepare = prepare;
    };
  }
  const memoryBeforeCold = await retainedMemory();
  let latest = read(scopes[0]!, undefined, limits);
  const golden = JSON.stringify(latest.events);
  const coldNavigation = values.mode === "navigation" ? { ...navigation } : undefined;
  const memoryAfterCold = await retainedMemory();
  for (let index = 0; index < 32; index++) {
    read(scopes[index % sessions]!, undefined, limits);
  }
  const memoryAfterWarmup = await retainedMemory();
  const warmNavigation = { ...navigation };
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
  const loadBefore = os.loadavg();
  const beforeCpu = process.threadCpuUsage();
  const started = performance.now();
  let eventCount = 0;
  for (let index = 0; index < iterations; index++) {
    latest = read(scopes[index % sessions]!, undefined, limits);
    eventCount += latest.events.length;
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(beforeCpu);
  const sampled =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  const measuredNavigation =
    values.mode === "navigation"
      ? {
          queries: navigation.queries - warmNavigation.queries,
          fullQueries: navigation.fullQueries - warmNavigation.fullQueries,
          rows: navigation.rows - warmNavigation.rows,
        }
      : undefined;
  assert.equal(JSON.stringify(read(scopes[0]!, undefined, limits).events), golden);
  const memoryAfterReads = await retainedMemory();
  const result = {
    mode: values.mode,
    node: process.version,
    iterations,
    sessions,
    turns,
    limits,
    ownerSha256: hash("sha256", readFileSync(sourceUrl)),
    navigationOwnerSha256: hash("sha256", readFileSync(navigationSourceUrl)),
    eventCount,
    eventsPerRead: latest.events.length,
    firstSessionEventBytes: Buffer.byteLength(golden),
    firstSessionEventSha256: hash("sha256", golden),
    wallMs: values.mode === "timing" ? wallMs : undefined,
    cpuMs: values.mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
    cpuUsPerRead: values.mode === "timing" ? (cpu.user + cpu.system) / iterations : undefined,
    allocatedBytes: sampled ? allocatedBytes(sampled.profile.head) : undefined,
    allocatedBytesPerRead: sampled ? allocatedBytes(sampled.profile.head) / iterations : undefined,
    gcMs: values.mode === "timing" ? pauses.reduce((sum, pause) => sum + pause, 0) : undefined,
    gcCount: values.mode === "timing" ? pauses.length : undefined,
    gcMaxMs: values.mode === "timing" ? Math.max(0, ...pauses) : undefined,
    memory: process.memoryUsage(),
    navigation:
      values.mode === "navigation"
        ? { cold: coldNavigation, measured: measuredNavigation }
        : undefined,
    retainedMemory:
      values.mode === "navigation"
        ? {
            beforeCold: memoryBeforeCold,
            afterCold: memoryAfterCold,
            afterWarmup: memoryAfterWarmup,
            afterReads: memoryAfterReads,
          }
        : undefined,
    loadBefore,
    loadAfter: os.loadavg(),
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (sampled) {
    writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(sampled.profile));
  }
  console.log(JSON.stringify(result));
} finally {
  restoreSqlObserver?.();
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
