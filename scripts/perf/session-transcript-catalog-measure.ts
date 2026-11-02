// Real catalog-page owner over 10k synthetic session rows and 16 user/tool transcripts.
// node --import ./scripts/tsx.mjs scripts/perf/session-transcript-catalog-measure.ts \
//   --output .local/catalog-candidate --mode timing --iterations 2000
// Add --owner-file .local/catalog-base.ts to substitute the exact baseline owner.
// Run timing/allocation separately and counterbalance base/candidate order. Setup is excluded.
// Acceptance: identical items/cursor positions, fewer worker requests, lower allocation/CPU
// without material adverse timing or GC. Inspector allocation covers the MAIN ISOLATE only;
// process CPU includes workers. This owner probe does not measure whole-Gateway stress.
// Output identity hashes omit cursor scope/source, which bind each fixture's unique DB path.
// Each run still verifies exact cursor bytes against its own unchanged fixture.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptCatalogPage } from "../../src/gateway/session-transcript-catalog.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
    rows: { type: "string", default: "10000" },
    sessions: { type: "string", default: "16" },
    turns: { type: "string", default: "64" },
    limit: { type: "string", default: "20" },
  },
});
assert(values.output, "--output is required and must be a new directory");
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
const iterations = Number(values.iterations);
const rows = Number(values.rows);
const sessions = Number(values.sessions);
const turns = Number(values.turns);
const limit = Number(values.limit);
for (const count of [iterations, rows, sessions, turns, limit]) {
  assert(Number.isSafeInteger(count) && count > 0, "Counts must be positive safe integers");
}
assert(rows >= sessions, "--rows must cover --sessions");
assert(limit <= 200, "--limit must be at most 200");
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
const ownerUrl = new URL("../../src/gateway/session-transcript-catalog.ts", import.meta.url);
const sourceUrl = values["owner-file"]
  ? pathToFileURL(path.resolve(values["owner-file"]))
  : ownerUrl;
let ownerLoaded = false;
if (values["owner-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        ownerLoaded = true;
        const loaded = nextLoad(sourceUrl.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { readSessionTranscriptCatalogPage: read } =
  await import("../../src/gateway/session-transcript-catalog.js");
assert(!values["owner-file"] || ownerLoaded, "Baseline owner substitution was not loaded");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const { resolveOpenClawAgentSqlitePath, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
setRuntimeConfigSnapshot({});
const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
const scopes = Array.from({ length: rows }, (_, index) => ({
  agentId: "main",
  sessionId: `synthetic-catalog-${index}`,
  sessionKey: `agent:main:synthetic-catalog-${index}`,
  storePath,
  env,
}));
const params = scopes
  .slice(0, sessions)
  .map((scope) =>
    Object.assign({ limit, sourceDomain: "synthetic-catalog", pluginId: "session-share" }, scope),
  );
const timestamp = "2026-10-25T00:00:00.000Z";
const text = 'synthetic 🦞 "file"\\path\n'.repeat(16);
function events(sessionId: string): TranscriptEvent[] {
  const result: TranscriptEvent[] = [
    { type: "session", version: 3, id: sessionId, cwd: "/synthetic", timestamp },
  ];
  let parentId: string | null = null;
  for (let turn = 0; turn < turns; turn++) {
    for (const message of [
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
    ]) {
      const id = `entry-${result.length}`;
      result.push({ type: "message", id, parentId, timestamp, message });
      parentId = id;
    }
  }
  return result;
}
function comparablePage(page: SessionTranscriptCatalogPage) {
  const cursor: unknown = page.nextCursor
    ? JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"))
    : undefined;
  if (cursor !== undefined) {
    assert(cursor && typeof cursor === "object" && "scope" in cursor && "source" in cursor);
    const { scope: _scope, source: _source, ...position } = cursor;
    return { items: page.items, cursor: position };
  }
  return { items: page.items };
}
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
const inspector = new Session();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    pauses.push(entry.duration);
  }
});
const tasks = channel("openclaw.worker.task");
const workerTasks: Record<string, number> = {};
const recordTask = (value: unknown) => {
  if (value && typeof value === "object" && "worker" in value && typeof value.worker === "string") {
    workerTasks[value.worker] = (workerTasks[value.worker] ?? 0) + 1;
  }
};
try {
  for (let offset = 0; offset < rows; offset += 1000) {
    await importSqliteSessionRowsBatch(
      scopes.slice(offset, offset + 1000).map((scope, index) =>
        Object.assign(
          {
            entry: { sessionId: scope.sessionId, updatedAt: 1 },
            ...(offset + index < sessions
              ? {
                  transcriptMtimeMs: 1,
                  readTranscriptEvents: (append: (event: TranscriptEvent) => void) => {
                    for (const event of events(scope.sessionId)) {
                      append(event);
                    }
                  },
                }
              : {}),
          },
          scope,
        ),
      ),
    );
  }
  const golden: string[] = [];
  for (const target of params) {
    const page = await read(target);
    assert.equal(page.items[0]?.text, `Answer ${turns - 1}: ${text}`);
    golden.push(JSON.stringify(page));
  }
  for (let index = 0; index < 32; index++) {
    await read(params[index % sessions]!);
  }
  await setImmediate();
  const latest = new Map<number, SessionTranscriptCatalogPage>();
  observer.observe({ entryTypes: ["gc"] });
  tasks.subscribe(recordTask);
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = os.loadavg();
  const memoryBefore = process.memoryUsage();
  const beforeThreadCpu = process.threadCpuUsage();
  const beforeProcessCpu = process.cpuUsage();
  const started = performance.now();
  let itemCount = 0;
  let cursorCount = 0;
  for (let index = 0; index < iterations; index++) {
    const session = index % sessions;
    const page = await read(params[session]!);
    latest.set(session, page);
    itemCount += page.items.length;
    cursorCount += Number(page.nextCursor !== undefined);
  }
  const wallMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(beforeThreadCpu);
  const processCpu = process.cpuUsage(beforeProcessCpu);
  const memoryAfter = process.memoryUsage();
  const loadAfter = os.loadavg();
  tasks.unsubscribe(recordTask);
  const sampled =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  for (const [index, page] of latest) {
    assert.equal(JSON.stringify(page), golden[index], "Unchanged page/cursor bytes differ");
  }
  const firstPage = await read(params[0]!);
  assert.equal(JSON.stringify(firstPage), golden[0]);
  const result = {
    mode: values.mode,
    node: process.version,
    iterations,
    rows,
    sessions,
    turns,
    limit,
    ownerSha256: hash("sha256", readFileSync(sourceUrl)),
    itemCount,
    cursorCount,
    firstPageItems: firstPage.items.length,
    firstPageItemsSha256: hash("sha256", JSON.stringify(firstPage.items)),
    firstPageCursor: comparablePage(firstPage).cursor,
    firstPageSha256: hash("sha256", JSON.stringify(comparablePage(firstPage))),
    workerTasks,
    workerTasksPerRead:
      Object.values(workerTasks).reduce((sum, count) => sum + count, 0) / iterations,
    wallMs: values.mode === "timing" ? wallMs : undefined,
    threadCpuMs: values.mode === "timing" ? (threadCpu.user + threadCpu.system) / 1000 : undefined,
    processCpuMs:
      values.mode === "timing" ? (processCpu.user + processCpu.system) / 1000 : undefined,
    mainAllocatedBytes: sampled ? allocatedBytes(sampled.profile.head) : undefined,
    mainAllocatedBytesPerRead: sampled
      ? allocatedBytes(sampled.profile.head) / iterations
      : undefined,
    mainGcMs: values.mode === "timing" ? pauses.reduce((sum, pause) => sum + pause, 0) : undefined,
    mainGcCount: values.mode === "timing" ? pauses.length : undefined,
    mainGcMaxMs: values.mode === "timing" ? Math.max(0, ...pauses) : undefined,
    memoryBefore,
    memoryAfter,
    loadBefore,
    loadAfter,
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (sampled) {
    writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(sampled.profile));
  }
  console.log(JSON.stringify(result));
} finally {
  tasks.unsubscribe(recordTask);
  observer.disconnect();
  inspector.disconnect();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
