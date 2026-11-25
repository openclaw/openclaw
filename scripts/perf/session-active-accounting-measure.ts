/**
 * Real history-worker accounting and concurrent unrelated session writes.
 * First create a synthetic team-shape-fixture.ts --state-dir, then run --prepare.
 * Its background --transcript-mib controls database size independently of the
 * 40,000-event accounting target. Inspect physical bytes; compression and indexes
 * make logical bytes a poor size proxy. No live state or copied data is accepted.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-active-accounting-measure.ts
 *   --state-dir <fixture> --prepare --events 40000
 * Repeat without --prepare: --label A1 --scenario bounded|estimate|after-append|bytes-after-append|actor-bytes-after-append
 *   --samples 5 --iterations 10 --mode timing|allocation
 * Run A1/A2 controls and baseline/candidate serially in counterbalanced order,
 * using separate processes at each head. For all-thread CPU profiles add
 * --cpu-prof --cpu-prof-dir=<dir> --import ./scripts/lib/gateway-bench-cpu-profile.mjs.
 * For cumulative worker allocation (including collected objects), use the
 * gateway-bench-heap-profile.mjs preload with its absolute output directory query.
 * Acceptance: exact accounting, no history-sized per-turn scan, lower read/write
 * latency and CPU/allocation beyond A/A spread, no >20% regression in any metric.
 * Cold means first request in this process, not eviction of the OS page cache.
 * Allocation is sampled MAIN-thread allocation; process CPU includes workers.
 */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    prepare: { type: "boolean" },
    events: { type: "string", default: "40000" },
    "payload-bytes": { type: "string", default: "1024" },
    "signature-bytes": { type: "string", default: "16384" },
    "write-delay-ms": { type: "string", default: "5" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "10" },
    label: { type: "string", default: "candidate" },
    scenario: { type: "string", default: "bounded" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values["state-dir"], "--state-dir must name a synthetic team-shape fixture");
assert(
  [
    "bounded",
    "estimate",
    "after-append",
    "bytes-after-append",
    "actor-bytes-after-append",
  ].includes(values.scenario),
);
assert(["timing", "allocation"].includes(values.mode));
const integer = (value: string, minimum: number) => {
  const number = Number(value);
  assert(Number.isSafeInteger(number) && number >= minimum);
  return number;
};
const eventCount = integer(values.events, 2);
const payloadBytes = integer(values["payload-bytes"], 1);
const signatureBytes = integer(values["signature-bytes"], 0);
const writeDelayMs = integer(values["write-delay-ms"], 0);
const samples = integer(values.samples, 1);
const iterations = integer(values.iterations, 1);
assert(global.gc, "use --expose-gc");
const root = path.resolve(values["state-dir"]);
const team = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(team.format, "openclaw-team-shape-v1");
const manifestPath = path.join(root, "active-accounting-fixture.json");
const configPath = path.join(root, "openclaw.json");
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
process.env = env;
const { setRuntimeConfigSnapshot } = await import("../../src/config/config.js");
setRuntimeConfigSnapshot({
  ...config,
  session: {
    ...config.session,
    maintenance: {
      ...config.session?.maintenance,
      mode: "enforce",
      pruneAfter: "365d",
      archiveDashboardAfter: "365d",
      maxEntries: Math.max(5_000, team.sessionCount + 3),
      maxDiskBytes: 100 * 1024 ** 3,
    },
  },
});
const { loadSessionEntry, patchSessionEntryCore } =
  await import("../../src/config/sessions/session-accessor.js");
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const { persistSessionTranscriptTurn } =
  await import("../../src/config/sessions/session-accessor.transcript-turn.js");
const { acquireSessionInputActor, withSessionInputActor } =
  await import("../../src/config/sessions/session-input-actor.js");
const { readSessionTranscriptAccountingAsync } =
  await import("../../src/gateway/session-transcript-readers.js");
const { estimateContextTokensFromSessionTranscript } =
  await import("../../src/auto-reply/reply/agent-runner-memory-transcript-context.js");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.js");
const { resolveOpenClawAgentSqlitePath, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const storePath = resolveSessionStorePathCore(config.session?.store, { agentId: "main", env });
const targets = ["synthetic-active-accounting", "synthetic-active-accounting-append"].map(
  (sessionId) => ({
    agentId: "main",
    env,
    storePath,
    sessionKey: `agent:main:${sessionId}`,
    sessionId,
  }),
);
const target = targets[values.scenario.endsWith("after-append") ? 1 : 0]!;
const writer = {
  ...target,
  sessionKey: "agent:main:synthetic-accounting-write-probe",
  sessionId: "synthetic-accounting-write-probe",
};
const usage = { input: 4096, output: 64 };
const inspector = new Session();
let inputActor: Awaited<ReturnType<typeof acquireSessionInputActor>>;
const sumAllocation = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sumAllocation(child), 0);
const stats = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
};
try {
  if (values.prepare) {
    for (const selected of targets) {
      assert(!loadSessionEntry(selected), "Refusing to replace an existing accounting target");
    }
    assert(!loadSessionEntry(writer), "Refusing to replace an existing writer target");
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const cipher = createCipheriv(
      "aes-256-ctr",
      createHash("sha256").update("synthetic-active-accounting-v1").digest(),
      Buffer.alloc(16),
    );
    const text = (bytes: number) =>
      cipher
        .update(Buffer.alloc(Math.ceil((bytes * 3) / 4)))
        .toString("base64")
        .slice(0, bytes);
    let byteSize = 0;
    await importSqliteSessionRowsBatch([
      ...targets.map((selected) =>
        Object.assign({}, selected, {
          entry: { sessionId: selected.sessionId, updatedAt: now, lifecycleRevision: "synthetic" },
          transcriptMtimeMs: now,
          readTranscriptEvents(append: (event: TranscriptEvent) => void) {
            byteSize = 0;
            append({ type: "session", version: 3, id: selected.sessionId, timestamp });
            for (let index = 0; index < eventCount; index++) {
              const assistant = index % 2 === 1 || index === eventCount - 1;
              const event: TranscriptEvent = {
                type: "message",
                id: `accounting-${index}`,
                parentId: index ? `accounting-${index - 1}` : null,
                timestamp,
                message: {
                  role: assistant ? "assistant" : "user",
                  content: [
                    ...(assistant && signatureBytes
                      ? [
                          {
                            type: "thinking",
                            thinking: "Synthetic reasoning",
                            thinkingSignature: text(signatureBytes),
                          },
                        ]
                      : []),
                    { type: "text", text: text(payloadBytes) },
                  ],
                  ...(assistant && index < eventCount - 1024 ? { usage } : {}),
                },
              };
              byteSize += Buffer.byteLength(JSON.stringify(event)) + 1;
              append(event);
            }
          },
        }),
      ),
      {
        ...writer,
        entry: { sessionId: writer.sessionId, updatedAt: now, lifecycleRevision: "synthetic" },
      },
    ]);
    cipher.final();
    const manifest = {
      format: "openclaw-active-accounting-v1",
      eventCount,
      byteSize,
      payloadBytes,
      signatureBytes,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ prepared: manifest }));
  } else {
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(fixture.format, "openclaw-active-accounting-v1");
    assert(loadSessionEntry(target) && loadSessionEntry(writer));
    const databaseBytes = statSync(resolveOpenClawAgentSqlitePath({ agentId: "main", env })).size;
    const options = {
      includeByteSize: true,
      includeUsage: !values.scenario.endsWith("bytes-after-append"),
    };
    const read = () =>
      values.scenario === "estimate"
        ? estimateContextTokensFromSessionTranscript({ ...target, contextWindowTokens: 1_000_000 })
        : readSessionTranscriptAccountingAsync(target, options);
    const checkResult = (result: Awaited<ReturnType<typeof read>>) => {
      assert(result);
      if (values.scenario === "estimate") {
        assert("contextTokens" in result && Number.isFinite(result.contextTokens));
      } else {
        assert("eventCount" in result && typeof result.eventCount === "number");
        assert(result.eventCount >= fixture.eventCount);
        assert(typeof result.byteSize === "number" && result.byteSize >= fixture.byteSize);
      }
      return result;
    };
    let writeSequence = 0;
    const write = () =>
      patchSessionEntryCore(writer, () => ({ label: `write-probe-${++writeSequence}` }), {
        skipMaintenance: true,
        preserveActivity: true,
      });
    // Warm only the unrelated writer; the first accounting request stays cold.
    await write();
    const coldStarted = performance.now();
    const cold = checkResult(await read());
    const coldMs = performance.now() - coldStarted;
    console.log(
      JSON.stringify({
        phase: "cold",
        label: values.label,
        scenario: values.scenario,
        coldMs,
        result:
          "contextTokens" in cold
            ? cold
            : {
                eventCount: cold.eventCount,
                byteSize: cold.byteSize,
                trailingMessages: cold.usage?.trailingMessages.length,
              },
        databaseBytes,
        sessions: team.sessionCount + 3,
        worktreeFiles: team.worktreeFiles,
      }),
    );
    if (values.scenario === "actor-bytes-after-append") {
      inputActor = await acquireSessionInputActor(
        {
          agentId: target.agentId,
          env,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env }),
          target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
        },
        { assertCurrent() {}, assertReadable() {} },
      );
      assert(inputActor);
    }
    for (let sample = 0; sample < samples; sample++) {
      global.gc();
      if (values.mode === "allocation") {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const reservations: unknown[] = [];
      const observe = (event: unknown) => reservations.push(event);
      const diagnostics = channel("openclaw.agent-database.reservation");
      diagnostics.subscribe(observe);
      const readMs: number[] = [];
      const writeMs: number[] = [];
      let concurrentStarts = 0;
      let writesFinishedFirst = 0;
      const cpu = process.cpuUsage();
      const mainCpu = process.threadCpuUsage();
      for (let iteration = 0; iteration < iterations; iteration++) {
        if (values.scenario.endsWith("after-append")) {
          const append = () =>
            persistSessionTranscriptTurn(target, {
              messages: [
                { message: { role: "assistant", content: "Synthetic appended answer", usage } },
              ],
              touchSessionEntry: false,
              ...(inputActor ? { expectedSessionId: target.sessionId } : {}),
            });
          const actor = inputActor;
          if (actor) {
            await withSessionInputActor(
              { phase: "acceptInput", acquire: async () => actor },
              append,
            );
          } else {
            await append();
          }
        }
        let readFinished = false;
        const started = performance.now();
        const reading = read().then((result) => {
          readMs.push(performance.now() - started);
          readFinished = true;
          checkResult(result);
        });
        await delay(writeDelayMs);
        concurrentStarts += Number(!readFinished);
        const writeStarted = performance.now();
        await write();
        writeMs.push(performance.now() - writeStarted);
        writesFinishedFirst += Number(!readFinished);
        await reading;
      }
      const usedCpu = process.cpuUsage(cpu);
      const usedMainCpu = process.threadCpuUsage(mainCpu);
      diagnostics.unsubscribe(observe);
      const allocation =
        values.mode === "allocation"
          ? await inspector.post("HeapProfiler.stopSampling")
          : undefined;
      if (allocation) {
        inspector.disconnect();
      }
      console.log(
        JSON.stringify({
          phase: "warm",
          label: values.label,
          scenario: values.scenario,
          mode: values.mode,
          sample: sample + 1,
          iterations,
          concurrentStarts,
          writesFinishedFirst,
          readMs: stats(readMs),
          writeMs: stats(writeMs),
          processCpuMs: (usedCpu.user + usedCpu.system) / 1000,
          mainThreadCpuMs: (usedMainCpu.user + usedMainCpu.system) / 1000,
          mainThreadAllocatedBytes: allocation ? sumAllocation(allocation.profile.head) : undefined,
          memory: process.memoryUsage(),
          reservations,
          hostLoad: loadavg(),
        }),
      );
    }
    // Let worker allocation sampling capture completed work before owner shutdown.
    if (values.mode === "allocation") {
      await delay(1200);
    }
  }
} finally {
  inspector.disconnect();
  await inputActor?.actor.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
