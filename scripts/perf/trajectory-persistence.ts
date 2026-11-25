/**
 * Synthetic real-recorder/SQLite proof; complements, never replaces, Gateway stress.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trajectory-persistence.ts \
 *   --state-dir "$PWD/.local/trajectory-candidate" --mode timing --turns 30
 * Repeat with --mode allocation in a fresh directory. Allocation sampling includes
 * collected objects; only untraced timing runs gate CPU, flush latency and GC.
 * Baseline: preserve changed source modules under their repository-relative paths
 * in an overlay; set OPENCLAW_BENCH_BASELINE_DIR=/absolute/overlay and add
 * --import ./scripts/perf/worker-retained-heap-preload.ts after the TSX preload.
 * Candidate: omit the overlay. Pass --compare-golden <base>/persisted-normalized.jsonl
 * to require identical persisted bytes, normalizing ONLY envelope timestamps.
 * Use identical --turns and counterbalanced launch order. Fixtures, recorder setup,
 * forced GC and persisted readback are outside capture/flush timing. Allocation
 * covers capture plus flush and measurement bookkeeping, in the main isolate only.
 * Runtime intentionally preserves credential-looking strings; media capture remains
 * redacted. Export credential redaction needs its own proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DB } from "../../src/state/openclaw-agent-db.generated.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "30" },
    variant: { type: "string", default: "candidate" },
    "compare-golden": { type: "string" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(values["state-dir"], "Use a new isolated --state-dir");
assert(["timing", "allocation"].includes(values.mode));
const turns = parseStrictIntegerOption({
  raw: values.turns,
  fallback: 30,
  min: 1,
  label: "--turns",
});
assert(turns <= 1000, "Use at most 1000 turns per process");
const root = path.resolve(values["state-dir"]);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeRelativePath = "src/trajectory/runtime.ts";
const overlayRuntime = process.env.OPENCLAW_BENCH_BASELINE_DIR
  ? path.join(process.env.OPENCLAW_BENCH_BASELINE_DIR, runtimeRelativePath)
  : undefined;
const runtimeSource =
  overlayRuntime && fs.existsSync(overlayRuntime)
    ? overlayRuntime
    : path.join(repositoryRoot, runtimeRelativePath);
const runtimeSourceSha256 = createHash("sha256")
  .update(fs.readFileSync(runtimeSource))
  .digest("hex");
assert(!fs.existsSync(root), "Refusing to reuse existing state");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, "home"));
fs.mkdirSync(path.join(root, "tmp"));
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_TRAJECTORY: "1",
  TMPDIR: path.join(root, "tmp"),
});
const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const { createTrajectoryRuntimeRecorder } = await import("../../src/trajectory/runtime.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { withOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
const { getNodeSqliteKysely, executeSqliteQuerySync } =
  await import("../../src/infra/kysely-sync.js");
const { readTrajectoryPayload } = await import("../../src/trajectory/runtime-payload.js");

type EventInput = { type: string; data: Record<string, unknown> };
function fixture(index: number): EventInput[] {
  const prompt = `Synthetic request ${index}: inspect the fixture and summarize.`;
  const systemPrompt = "Synthetic system instruction with ordinary prose. ".repeat(160);
  const messages = Array.from({ length: 24 }, (_, message) => ({
    role: message % 2 ? "assistant" : "user",
    ...(message % 2
      ? {
          providerReplay: {
            v: 1,
            type: "anthropic-compaction",
            data: "opaque".repeat(8192),
            provider: "synthetic",
            api: "synthetic",
            model: "mock",
          },
        }
      : {}),
    content: [{ type: "text", text: `Message ${message}. ${"Synthetic context. ".repeat(48)}` }],
  }));
  const tools = Array.from({ length: 40 }, (_, tool) => ({
    name: `synthetic_tool_${tool}`,
    description: "Inspect a synthetic fixture. ".repeat(8),
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["query"],
    },
  }));
  const usage = { input: 4000, output: 120, total: 4120 };
  const circular: Record<string, unknown> = { name: "synthetic cycle" };
  circular.self = circular;
  return [
    { type: "session.started", data: { toolCount: 40, agentId: "main", trigger: "synthetic" } },
    {
      type: "trace.metadata",
      data: {
        skills: tools.map(({ name, description }) => ({ name, description })),
        model: "mock",
      },
    },
    { type: "context.compiled", data: { prompt, systemPrompt, messages, tools } },
    { type: "prompt.submitted", data: { prompt, systemPrompt, messages, imagesCount: 1 } },
    {
      type: "tool.call",
      data: {
        toolCallId: "call-1",
        name: "synthetic_tool_0",
        args: {
          query: prompt,
          apiKey: "synthetic-secret-123456789",
          authorization: "Bearer synthetic-credential-123456",
        },
      },
    },
    {
      type: "tool.result",
      data: {
        toolCallId: "call-1",
        name: "synthetic_tool_0",
        success: true,
        result: {
          content: [
            { type: "text", text: "Synthetic result. ".repeat(400) },
            { type: "image", data: "c3ludGhldGljLWltYWdl", mimeType: "image/png" },
          ],
        },
      },
    },
    {
      type: "tool.result",
      data: {
        toolCallId: "call-large",
        name: "synthetic_tool_1",
        success: true,
        contentItems: Array.from({ length: 64 }, (_, item) => ({
          text: `${item}: ${"x".repeat(8192)}`,
        })),
      },
    },
    {
      type: "model.completed",
      data: {
        usage,
        messagesSnapshot: messages,
        finalPromptText: prompt,
        assistantTexts: ["Synthetic completion."],
      },
    },
    {
      type: "trace.artifacts",
      data: {
        usage,
        bigint: 12345678901234567890n,
        callback: () => undefined,
        custom: { toJSON: () => ({ bigint: 123n, callback: () => undefined }) },
        circular,
        sparse: Object.assign([], { length: 4, 0: undefined, 2: Number.NaN, 3: -0 }),
        binary: new Uint8Array([1, 2, 3]),
        imageUrl: "data:image/png;base64,c3ludGhldGljLWltYWdl",
      },
    },
    { type: "session.ended", data: { status: "success", aborted: false } },
  ];
}
async function prepare(index: number) {
  const sessionId = `synthetic-trajectory-${index}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents/main/sessions/sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
  const recorder = await createTrajectoryRuntimeRecorder({
    ...target,
    sessionTarget: target,
    runId: `synthetic-run-${index}`,
    provider: "synthetic",
    modelId: "mock",
    workspaceDir: "/synthetic/trajectory-workspace",
  });
  assert(recorder);
  return { recorder, events: fixture(index) };
}
const rows: Array<{
  captureWallMs: number;
  captureMainCpuMs: number;
  flushWallMs: number;
  flushMainCpuMs: number;
  flushProcessCpuMs: number;
}> = [];
const collections: Array<{ start: number; kind: number; durationMs: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
    collections.push({ start: entry.startTime, kind: detail.kind, durationMs: entry.duration });
  }
});
const inspector = new Session();
let sampling = false;
try {
  const warm = await prepare(-1);
  for (const event of warm.events) {
    warm.recorder.recordEvent(event.type, event.data);
  }
  await warm.recorder.flush();
  const work = [];
  for (let index = 0; index < turns; index++) {
    work.push(await prepare(index));
  }
  global.gc();
  await nextTurn();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    sampling = true;
  }
  const memoryBefore = process.memoryUsage();
  observer.observe({ entryTypes: ["gc"] });
  const workStarted = performance.now();
  for (const { recorder, events } of work) {
    const captureCpu = process.threadCpuUsage();
    const captureAt = performance.now();
    for (const event of events) {
      recorder.recordEvent(event.type, event.data);
    }
    const captureWallMs = performance.now() - captureAt;
    const captureDelta = process.threadCpuUsage(captureCpu);
    const flushCpu = process.threadCpuUsage();
    const flushProcess = process.cpuUsage();
    const flushAt = performance.now();
    await recorder.flush();
    const flushWallMs = performance.now() - flushAt;
    const flushDelta = process.threadCpuUsage(flushCpu);
    const processDelta = process.cpuUsage(flushProcess);
    assert.equal(recorder.describeFlushState(), undefined);
    rows.push({
      captureWallMs,
      captureMainCpuMs: (captureDelta.user + captureDelta.system) / 1000,
      flushWallMs,
      flushMainCpuMs: (flushDelta.user + flushDelta.system) / 1000,
      flushProcessCpuMs: (processDelta.user + processDelta.system) / 1000,
    });
  }
  const workEnded = performance.now();
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let allocation;
  if (sampling) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampling = false;
    inspector.disconnect();
    let bytes = 0;
    function visit(node: typeof profile.head) {
      bytes += node.selfSize;
      for (const child of node.children) {
        visit(child);
      }
    }
    visit(profile.head);
    fs.writeFileSync(path.join(root, "allocation.heapprofile"), JSON.stringify(profile));
    allocation = {
      sampledBytes: bytes,
      sampledBytesPerTurn: bytes / turns,
      samples: profile.samples.length,
      samplingInterval: 8192,
    };
  }
  await closeOpenClawAgentDatabasesAsync();
  // One-shot offline readback outside measurement preserves JSON bytes before parsing.
  const persisted = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getNodeSqliteKysely<DB>(database.db);
      return executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select([
            "run_id",
            "seq",
            "event_json",
            "event_payload",
            "event_codec",
            "event_utf8_bytes",
          ])
          .where("run_id", "!=", "synthetic-run--1")
          .orderBy("session_id")
          .orderBy("seq"),
      ).rows;
    },
    { agentId: "main" },
  );
  assert(persisted.found);
  assert.equal(persisted.value.length, turns * 10, "Every phase must reach SQLite");
  const normalized =
    persisted.value
      .map((row) => {
        const line = readTrajectoryPayload(row);
        const event = JSON.parse(line);
        assert.equal(typeof event.ts, "string");
        assert(Number.isFinite(Date.parse(event.ts)));
        return line.replace(`"ts":${JSON.stringify(event.ts)}`, '"ts":"<timestamp>"');
      })
      .join("\n") + "\n";
  const goldenPath = path.join(root, "persisted-normalized.jsonl");
  fs.writeFileSync(goldenPath, normalized);
  if (values["compare-golden"]) {
    assert(
      normalized === fs.readFileSync(values["compare-golden"], "utf8"),
      `Persisted bytes differ from the baseline; inspect ${goldenPath}`,
    );
  }
  const summarize = (key: keyof (typeof rows)[number]) => {
    const sorted = rows.map((row) => row[key]).toSorted((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      count: sorted.length,
      total,
      mean: total / turns,
      p50: sorted[Math.ceil(turns * 0.5) - 1],
      p95: sorted[Math.ceil(turns * 0.95) - 1],
      max: sorted.at(-1),
    };
  };
  const gc = collections.filter((entry) => entry.start >= workStarted && entry.start < workEnded);
  const result = {
    variant: values.variant,
    mode: values.mode,
    node: process.version,
    runtimeSource,
    runtimeSourceSha256,
    turns,
    persistedEvents: persisted.value.length,
    goldenPath,
    goldenHash: createHash("sha256").update(normalized).digest("hex"),
    goldenCompared: Boolean(values["compare-golden"]),
    workMs: workEnded - workStarted,
    captureWallMs: summarize("captureWallMs"),
    captureMainCpuMs: summarize("captureMainCpuMs"),
    flushWallMs: summarize("flushWallMs"),
    flushMainCpuMs: summarize("flushMainCpuMs"),
    flushProcessCpuMs: summarize("flushProcessCpuMs"),
    allocation,
    gc: [...new Set(gc.map((entry) => entry.kind))].map((kind) => {
      const pauses = gc.filter((entry) => entry.kind === kind).map((entry) => entry.durationMs);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
        maxMs: Math.max(...pauses),
      };
    }),
    memory: { before: memoryBefore, after: memoryAfter },
    rows,
  };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  observer.disconnect();
  if (sampling) {
    await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
