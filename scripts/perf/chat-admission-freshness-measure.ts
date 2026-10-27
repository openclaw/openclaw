/**
 * Ordered admission reader cost with and without unused lifecycle freshness.
 * Synthetic 10,000-row state only; no Gateway or production access. Prepare once:
 * node --import ./scripts/tsx.mjs scripts/perf/chat-admission-freshness-measure.ts \
 *   --fixture .local/chat-admission-fixture --prepare
 * Then alternate --arm before / --arm after (2,000 reads each), separately for
 * --mode timing and --mode allocation, adding --expose-gc before --import.
 * The before request includes lifecycleSessionKey; after omits it, exactly as
 * non-restart-safe chat admission does. Restart-safe admission is unchanged.
 * Measures the real ordered reader and main-isolate allocation, not full chat
 * latency. The selected legacy row lacks sessionStartedAt and has a large saved
 * skills snapshot and 128-message history; 9,999 unrelated rows stay in storage.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    prepare: { type: "boolean", default: false },
    arm: { type: "string", default: "after" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.fixture, "--fixture must name synthetic state created by --prepare");
assert(values.arm === "before" || values.arm === "after", "Unknown arm");
assert(values.mode === "timing" || values.mode === "allocation", "Unknown mode");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 1, "Invalid iteration count");
const fixture = path.resolve(values.fixture);
const configPath = path.join(fixture, "config.json");
if (values.prepare) {
  mkdirSync(fixture);
  mkdirSync(path.join(fixture, "home"));
  mkdirSync(path.join(fixture, "tmp"));
  writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
}
process.env = {
  ...createGatewayBenchEnv(path.join(fixture, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: fixture,
  TMPDIR: path.join(fixture, "tmp"),
};
const owner = await import("../../src/state/openclaw-agent-db.js");
const options = { agentId: "main", env: process.env };
const sessionKey = "agent:main:admission-freshness-0";
const sessionId = "admission-freshness-0";
const inspector = new Session();
try {
  const database = owner.openOpenClawAgentDatabase(options);
  if (values.prepare) {
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    const { appendTranscriptEventsInTransaction } =
      await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
    owner.runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < 10_000; index++) {
        writeSessionEntry(database, `agent:main:admission-freshness-${index}`, {
          sessionId: `admission-freshness-${index}`,
          updatedAt: 1,
          lifecycleRevision: `synthetic-${index}`,
          status: "done",
          ...(index === 0
            ? { skillsSnapshot: { prompt: "Synthetic saved skill. ".repeat(2048), skills: [] } }
            : index % 2
              ? { archivedAt: 2 }
              : {}),
        });
      }
      appendTranscriptEventsInTransaction(database, { ...options, sessionKey, sessionId }, [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date(1).toISOString(),
          cwd: "/synthetic",
        },
        ...Array.from({ length: 128 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          timestamp: new Date(index + 2).toISOString(),
          message: {
            role: "user",
            content: "Synthetic prior message. ".repeat(256),
            timestamp: index + 2,
          },
        })),
      ]);
    }, options);
    console.log(
      JSON.stringify({
        fixture,
        sessions: 10_000,
        historyMessages: 128,
        selectedSessionStartedAt: null,
      }),
    );
  } else {
    assert(globalThis.gc, "Run measurements with --expose-gc");
    const { withSessionEntriesFromStoresInWorker } =
      await import("../../src/config/sessions/session-entry-read-runtime.js");
    const input = {
      ...options,
      storePath: database.path,
      sessionKeys: [sessionKey],
      snapshotFields: [] as const,
      includeAuthorization: true,
      ...(values.arm === "before" ? { lifecycleSessionKey: sessionKey } : {}),
    };
    let consumed = 0;
    const read = () =>
      withSessionEntriesFromStoresInWorker(
        [input],
        ([result]) => {
          assert(result);
          result.assertCurrent();
          const entry = result.result.entries[0]?.entry;
          assert.equal(entry?.sessionId, sessionId);
          assert.equal(entry?.lifecycleRevision, "synthetic-0");
          assert.equal(entry?.sessionStartedAt, undefined);
          assert.equal(entry?.skillsSnapshot, undefined);
          consumed++;
        },
        { ordered: true },
      );
    for (let index = 0; index < 20; index++) {
      await read();
    }
    consumed = 0;
    globalThis.gc();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const threadStart = process.threadCpuUsage();
    const processStart = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      await read();
    }
    const wallMs = performance.now() - started;
    const threadCpu = process.threadCpuUsage(threadStart);
    const processCpu = process.cpuUsage(processStart);
    let allocatedBytes: number | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    assert.equal(consumed, iterations);
    console.log(
      JSON.stringify({
        arm: values.arm,
        mode: values.mode,
        iterations,
        sessions: 10_000,
        wallMs,
        mainThreadCpuUsPerRead: (threadCpu.user + threadCpu.system) / iterations,
        processCpuUsPerRead: (processCpu.user + processCpu.system) / iterations,
        sampledMainThreadBytesPerRead:
          allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  }
} finally {
  inspector.disconnect();
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
}
