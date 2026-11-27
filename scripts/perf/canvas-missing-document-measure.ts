import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
/**
 * Missing-widget owner cost, excluding the unchanged session admission and transport.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/canvas-missing-document-measure.ts \
 *   --fixture /absolute/new/synthetic-fixture --prepare
 * Then repeat without --prepare, with --mode timing or allocation.
 * --native runs the SQLite match owner in this isolate for allocation/CPU profiles.
 * --workload mixed queues 32 missing views then measures a different session's
 * history page through the real shared history workers (use --iterations 2).
 * A/A controls precede five interleaved before/after pairs in each process.
 * Before: authorize the retained transcript receipt, then open the missing file.
 * After: the same missing file refuses before transcript matching. No negative cache.
 * Acceptance: identical missing-file outcome, zero history requests after, lower CPU,
 * no increase in main-isolate allocation. Process CPU includes history worker work.
 * This is 10k-session/10k-message owner proof, not 35-GiB/btrfs or full Gateway proof.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    prepare: { type: "boolean" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "20" },
    workload: { type: "string", default: "serial" },
    native: { type: "boolean" },
  },
});
assert(values.fixture, "--fixture must identify task-owned synthetic state");
assert(values.mode === "timing" || values.mode === "allocation");
assert(values.workload === "serial" || values.workload === "mixed");
assert(!values.native || values.workload === "serial");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
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
const { captureRuntimeConfigAsyncReader } = await import("../../src/config/io.runtime.js");
await captureRuntimeConfigAsyncReader()();
const owner = await import("../../src/state/openclaw-agent-db.js");
const { findTranscriptEvent } =
  await import("../../src/config/sessions/session-transcript-match.js");
const { createCanvasDocument, readCanvasDocumentHtmlSource, resolveCanvasDocumentsDir } =
  await import("../../src/canvas/documents.js");
const options = { agentId: "main", env: process.env };
const scope = {
  ...options,
  sessionKey: "agent:main:canvas-measure-0",
  sessionId: "canvas-measure-0",
};
const inspector = new Session();
try {
  if (values.prepare) {
    const database = owner.openOpenClawAgentDatabase(options);
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    const { appendTranscriptEventsInTransaction } =
      await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
    const { waitForSessionTranscriptProjection } =
      await import("../../src/config/sessions/session-accessor.js");
    const document = await createCanvasDocument({
      html: "<p>Synthetic pruned widget</p>",
      cspSandbox: "scripts",
    });
    owner.runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < 10_000; index++) {
        writeSessionEntry(database, `agent:main:canvas-measure-${index}`, {
          sessionId: `canvas-measure-${index}`,
          updatedAt: 1,
          status: "done",
        });
      }
      appendTranscriptEventsInTransaction(database, scope, [
        { type: "session", version: 3, id: scope.sessionId, cwd: "/synthetic" },
        {
          type: "message",
          id: "widget",
          parentId: null,
          message: {
            role: "toolResult",
            toolName: "show_widget",
            toolCallId: "synthetic-widget-call",
            content: [],
            details: {
              kind: "canvas",
              view: { id: document.id },
              presentation: { target: "assistant_message" },
            },
          },
        },
        ...Array.from({ length: 10_000 }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : "widget",
          message: {
            role: index % 2 ? "assistant" : "user",
            content: "Synthetic conversation content. ".repeat(256),
          },
        })),
      ]);
    }, options);
    await waitForSessionTranscriptProjection(scope);
    rmSync(path.join(resolveCanvasDocumentsDir(), document.id), { recursive: true });
    writeFileSync(path.join(fixture, "document-id.txt"), document.id);
    console.log(JSON.stringify({ fixture, sessions: 10_000, messages: 10_001 }));
  } else {
    assert(globalThis.gc, "Measurement requires --expose-gc");
    const docId = readFileSync(path.join(fixture, "document-id.txt"), "utf8");
    const { historyLane } =
      await import("../../src/config/sessions/session-transcript-worker-resources.js");
    const { findTranscriptEventMatchingInDatabase } =
      await import("../../src/config/sessions/session-transcript-match-read.js");
    const { readSessionMessagesPageWithStatsAsync } =
      await import("../../src/gateway/session-transcript-readers.js");
    const nativeDatabase = values.native ? owner.openOpenClawAgentDatabase(options) : undefined;
    let historyRequests = 0;
    let onHistoryRequest: (() => void) | undefined;
    const run = historyLane.pool.run;
    historyLane.pool.run = (...args) => {
      historyRequests++;
      onHistoryRequest?.();
      return run(...args);
    };
    const read = async (arm: "before" | "after") => {
      if (arm === "before") {
        const match = { kind: "canvas-widget" as const, docId };
        const found = nativeDatabase
          ? findTranscriptEventMatchingInDatabase(nativeDatabase, { target: scope, match })
          : await findTranscriptEvent(scope, match);
        assert.equal(asOptionalRecord(found?.event)?.id, "widget");
      }
      await assert.rejects(readCanvasDocumentHtmlSource(docId));
    };
    const readOtherSession = () =>
      readSessionMessagesPageWithStatsAsync(
        { ...options, sessionKey: "agent:main:canvas-measure-1", sessionId: "canvas-measure-1" },
        { offset: 0, maxMessages: 1, readOnly: true },
      );
    await readOtherSession();
    const workload = async (arm: "before" | "after") => {
      if (values.workload === "serial") {
        await read(arm);
        return undefined;
      }
      const burst = 32;
      const queuedThrough = historyRequests + burst;
      const queued =
        arm === "before"
          ? new Promise<void>((resolve) => {
              onHistoryRequest = () => {
                if (historyRequests >= queuedThrough) {
                  resolve();
                }
              };
            })
          : setImmediate();
      const storm = Promise.all(Array.from({ length: burst }, () => read(arm)));
      await Promise.race([queued, storm]);
      onHistoryRequest = undefined;
      const started = performance.now();
      const other = await readOtherSession();
      const followerMs = performance.now() - started;
      assert.equal(other.totalMessages, 0);
      await storm;
      return followerMs;
    };
    for (let index = 0; index < (values.workload === "mixed" ? 2 : 10); index++) {
      await workload("before");
      await workload("after");
    }
    if (values.mode === "allocation") {
      inspector.connect();
    }
    const measure = async (arm: "before" | "after", label: string) => {
      globalThis.gc!();
      if (values.mode === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 8192,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const hostLoad = loadavg();
      const processStart = process.cpuUsage();
      const mainStart = process.threadCpuUsage();
      const requestsBefore = historyRequests;
      const times: number[] = [];
      for (let index = 0; index < iterations; index++) {
        const started = performance.now();
        const followerMs = await workload(arm);
        times.push(followerMs ?? performance.now() - started);
      }
      const cpu = process.cpuUsage(processStart);
      const main = process.threadCpuUsage(mainStart);
      let bytes: number | undefined;
      if (values.mode === "allocation") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        bytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
      }
      const sorted = times.toSorted((a, b) => a - b);
      console.log(
        JSON.stringify({
          arm,
          label,
          mode: values.mode,
          workload: values.workload,
          native: Boolean(values.native),
          iterations,
          sessions: 10_000,
          messages: 10_001,
          historyRequests: historyRequests - requestsBefore,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          processCpuUsPerRead: (cpu.user + cpu.system) / iterations,
          mainCpuUsPerRead: (main.user + main.system) / iterations,
          sampledMainBytesPerRead: bytes,
          hostLoad,
        }),
      );
    };
    await measure("before", "control-A1");
    await measure("before", "control-A2");
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2
        ? (["after", "before"] as const)
        : (["before", "after"] as const)) {
        await measure(arm, `pair-${pair}`);
      }
    }
  }
} finally {
  inspector.disconnect();
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
}
