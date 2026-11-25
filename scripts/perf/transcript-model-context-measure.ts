// Real SQLite model-context owner, with synthetic user/tool turns and bounded reads.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-model-context-measure.ts \
//   --output .local/context-candidate --mode timing --iterations 2000
// Add --owner-file .local/context-base.ts to substitute the exact baseline owner.
// Run timing and allocation separately, counterbalancing base/candidate order.
// --sessions 1 measures a warm navigation cache; the default 16 rotates transcripts.
// Compacted identity history: --compacted-prefix-turns 4000 --turns 20 --sessions 2
//   --result-bytes 32768 --iterations 10 --warmups 2
// Optional logical SQLite reads: --vfs-probe <compiled transcript-active-facts-vfs.c library>.
// Probe runs clear the SQLite page cache per call; measure timing/allocation separately.
// Acceptance: identical event bytes/counts, less allocation, no material CPU regression.
// This is owner evidence, not a whole-Gateway load test. Fixture setup is excluded.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, type MessagePort } from "node:worker_threads";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

// Exercise dispatch's worker reader with the same host-owned SQLite write receipts.
if (isMainThread) {
  const { runPerfSqliteWorker } = await import("../lib/perf-sqlite-worker.ts");
  await runPerfSqliteWorker(new URL(import.meta.url), process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    sessions: { type: "string", default: "16" },
    turns: { type: "string", default: "64" },
    "compacted-prefix-turns": { type: "string", default: "0" },
    "result-bytes": { type: "string" },
    warmups: { type: "string", default: "32" },
    "vfs-probe": { type: "string" },
  },
});
assert(values.output, "--output is required and must be a new directory");
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
const iterations = Number(values.iterations);
const sessions = Number(values.sessions);
const turns = Number(values.turns);
const prefixTurns = Number(values["compacted-prefix-turns"]);
const warmups = Number(values.warmups);
const resultBytes =
  values["result-bytes"] === undefined ? undefined : Number(values["result-bytes"]);
assert(Number.isSafeInteger(prefixTurns) && prefixTurns >= 0);
assert(Number.isSafeInteger(warmups) && warmups >= 0);
assert(resultBytes === undefined || (Number.isSafeInteger(resultBytes) && resultBytes > 0));
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
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
const { readSessionTranscriptModelContext: read } =
  await import("../../src/config/sessions/session-accessor.sqlite-model-context.js");
assert(!values["owner-file"] || wasOwnerReplaced(), "Baseline owner substitution was not loaded");
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const { resolveOpenClawAgentSqlitePath, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { withOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
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
  for (let turn = 0; turn < turns + prefixTurns; turn++) {
    const firstTurnId = `entry-${result.length}`;
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
        content: [
          { type: "text", text: resultBytes === undefined ? text : "x".repeat(resultBytes) + "\0" },
        ],
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
    if (turn + 1 === prefixTurns) {
      const id = `entry-${result.length}`;
      result.push({
        type: "compaction",
        id,
        parentId,
        timestamp,
        summary: "Synthetic compaction",
        firstKeptEntryId: firstTurnId,
        tokensBefore: 100000,
      });
      parentId = id;
    }
  }
  return result;
}
const limits = { maxBytes: 1024 * 1024, maxEvents: 128 };
const inspector = new Session();
let probe: DatabaseSync | undefined;
let admissionPort: MessagePort | undefined;
let measuring = false;
let statementCount = 0;
const statements = channel("openclaw.database.statement");
const observeStatement = () => {
  if (measuring) {
    statementCount += 1;
  }
};
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
  await closeOpenClawAgentDatabasesAsync();
  const admission = new Promise<MessagePort>((resolve) => {
    parentPort!.once("message", resolve);
  });
  parentPort!.postMessage(storePath, []);
  const port = await admission;
  admissionPort = port;
  const { withSqliteDatabaseAdmissionExchange } =
    await import("../../src/infra/sqlite-database-admission-context.js");
  const { exchangeSqliteDatabaseAdmissions } =
    await import("../../src/infra/sqlite-worker-database-admission-relay.js");
  await withSqliteDatabaseAdmissionExchange(
    (records, location, create, observed) =>
      exchangeSqliteDatabaseAdmissions(port, records, location, create, observed),
    async () => {
      if (values["vfs-probe"]) {
        probe = new DatabaseSync(":memory:", { allowExtension: true });
        probe.loadExtension(path.resolve(values["vfs-probe"]), "sqlite3_bufprobe_init");
        probe.prepare("SELECT buf696_target(?, 1)").get(storePath);
      }
      let latest = read(scopes[0]!, undefined, limits);
      const golden = JSON.stringify(latest.events);
      for (let index = 0; index < warmups; index++) {
        read(scopes[index % sessions]!, undefined, limits);
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
      const loadBefore = os.loadavg();
      statements.subscribe(observeStatement);
      const beforeCpu = process.threadCpuUsage();
      const started = performance.now();
      const sqliteReadSamples: unknown[] = [];
      let eventCount = 0;
      for (let index = 0; index < iterations; index++) {
        if (probe) {
          withOpenClawAgentDatabaseReadOnly(
            ({ db }) => {
              db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA shrink_memory");
            },
            { agentId: "main", path: storePath, env },
          );
        }
        probe?.prepare("SELECT buf696_reset()").get();
        measuring = true;
        latest = read(scopes[index % sessions]!, undefined, limits);
        measuring = false;
        if (probe) {
          sqliteReadSamples.push(
            JSON.parse(String(probe.prepare("SELECT buf696_io() AS io").get()!.io)),
          );
        }
        eventCount += latest.events.length;
      }
      const wallMs = performance.now() - started;
      const cpu = process.threadCpuUsage(beforeCpu);
      const sampled =
        values.mode === "allocation"
          ? await inspector.post("HeapProfiler.stopSampling")
          : undefined;
      await setImmediate();
      await setImmediate();
      observer.disconnect();
      assert.equal(JSON.stringify(read(scopes[0]!, undefined, limits).events), golden);
      const result = {
        mode: values.mode,
        node: process.version,
        iterations,
        sessions,
        turns,
        prefixTurns,
        resultBytes,
        sqliteReadSamples: probe ? sqliteReadSamples : undefined,
        limits,
        ownerSha256: hash("sha256", readFileSync(sourceUrl)),
        eventCount,
        statementCount,
        eventsPerRead: latest.events.length,
        firstSessionEventBytes: Buffer.byteLength(golden),
        firstSessionEventSha256: hash("sha256", golden),
        wallMs: values.mode === "timing" ? wallMs : undefined,
        cpuMs: values.mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
        cpuUsPerRead: values.mode === "timing" ? (cpu.user + cpu.system) / iterations : undefined,
        allocatedBytes: sampled ? allocatedBytes(sampled.profile.head) : undefined,
        allocatedBytesPerRead: sampled
          ? allocatedBytes(sampled.profile.head) / iterations
          : undefined,
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
    },
  );
} finally {
  statements.unsubscribe(observeStatement);
  probe?.prepare("SELECT buf696_restore()").get();
  probe?.close();
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  admissionPort?.close();
  parentPort?.close();
}
