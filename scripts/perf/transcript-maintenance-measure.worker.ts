/**
 * Synthetic maintenance owner + actual MessagePort structured-clone measurement.
 * The worker queues its reply before signaling readiness on a separate port.
 * receiveMessageOnPort therefore puts native deserialization inside the measured
 * main-thread task, unlike an ordinary message callback which starts afterward.
 * This isolates receive/apply cost; it does not measure Gateway scheduling.
 *
 * Run via transcript-maintenance-measure.ts --workload code-mode-store. Alternate
 * baseline/candidate processes, five each, and baseline/baseline A/A controls.
 * --owner loads an exact baseline owner with current shared dependencies.
 * --background-mib distributes optional synthetic payload over --sessions; no
 * workspace is generated because this owner never reads workspace files.
 * --fixture-root keeps an explicitly marked synthetic database for paired runs;
 * each run resets only its selected transcript through the replacement owner.
 * --phase unchanged|append|cold-replay isolates allocation sampling workloads.
 * Timing excludes fixture writes and byte tracing; allocation is a separate run.
 */
import assert from "node:assert/strict";
import { createCipheriv, hash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { serialize } from "node:v8";
import {
  MessageChannel,
  parentPort,
  receiveMessageOnPort,
  Worker,
  workerData,
  type MessagePort,
} from "node:worker_threads";
import type { CodeModeStoreWrites } from "../../src/agents/code-mode-session-store-replay.js";
import type {
  SessionTranscriptMaintenanceCheckpoint,
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "../../src/config/sessions/session-transcript-hydration.types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

type Options = {
  variant: "baseline" | "candidate";
  iterations: number;
  sessions: number;
  events: number;
  eventBytes: number;
  backgroundMiB: number;
  allocations: boolean;
  owner?: string;
  profileDir?: string;
  fixtureRoot?: string;
  phase: string;
};
type Command =
  | { kind: "read"; request: SessionTranscriptMaintenanceRead; trace?: boolean }
  | { kind: "begin"; phase: string }
  | { kind: "end"; phase: string }
  | { kind: "append" }
  | { kind: "close" };
type Reply = {
  error?: string;
  fixture?: Record<string, unknown>;
  workerMs?: number;
  workerCpuMs?: number;
  sendMs?: number;
  sendCpuMs?: number;
  physicalReadBytes?: number;
  replyBytes?: number;
  sqlTextBytes?: number;
  sqlBlobBytes?: number;
  sqlRows?: number;
  allocatedBytes?: number;
};
type Projection = Map<string, { json: string; networkContent: boolean }>;
const cpuMs = (value: NodeJS.CpuUsage) => (value.user + value.system) / 1000;
const ownerUrl = new URL(
  "../../src/config/sessions/session-transcript-maintenance-read.ts",
  import.meta.url,
);

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    samples: sorted.length,
  };
}

export async function measureCodeModeMaintenance(options: Options) {
  assert(options.events > 1 && options.eventBytes >= 512);
  await mkdir(path.resolve(".local"), { recursive: true });
  const root = options.fixtureRoot
    ? path.resolve(options.fixtureRoot)
    : await mkdtemp(path.resolve(".local/maintenance-store-"));
  const manifestPath = path.join(root, "maintenance-fixture.json");
  const manifest = {
    format: "openclaw-transcript-maintenance-v1",
    sessions: options.sessions,
    backgroundMiB: options.backgroundMiB,
  };
  let reuse = false;
  if (options.fixtureRoot) {
    try {
      await mkdir(root);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      assert.deepEqual(
        JSON.parse(await readFile(manifestPath, "utf8")),
        manifest,
        "Not a matching completed synthetic fixture",
      );
      reuse = true;
    }
  }
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { options, root, port: port2, reuse },
    transferList: [port2],
  });
  const call = async (command?: Command): Promise<Reply> => {
    const pending = once(worker, "message");
    if (command) {
      worker.postMessage(command, []);
    }
    const [reply]: [Reply] = (await pending) as [Reply];
    assert.equal(reply.error, undefined);
    return reply;
  };
  const ready = call();
  const { collectCodeModeStoreWrites } =
    await import("../../src/agents/code-mode-session-store-replay.js");
  const { stringifyCodeModeJsonSafe } = await import("../../src/agents/code-mode-json.js");
  const { createMainThreadStallMonitor, runWithMainThreadTask } =
    await import("../../src/infra/main-thread-stall.js");
  const monitor = createMainThreadStallMonitor();
  const apply = (facts: SessionTranscriptMaintenanceFacts, initial: Projection): Projection => {
    const writes: CodeModeStoreWrites =
      facts.store?.writes ?? collectCodeModeStoreWrites(facts.events ?? []);
    const result = new Map(facts.store?.incremental ? initial : undefined);
    for (const [key, write] of writes) {
      if (write) {
        result.set(key, {
          json: stringifyCodeModeJsonSafe(write.value),
          networkContent: write.networkContent,
        });
      } else {
        result.delete(key);
      }
    }
    return result;
  };
  const receive = (initial: Projection) =>
    runWithMainThreadTask(
      "sessions.transcript-maintenance.measure",
      () => {
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        const message = receiveMessageOnPort(port1);
        assert(message, "Worker signaled before enqueueing its reply");
        const received = performance.now();
        const facts: SessionTranscriptMaintenanceFacts = message.message;
        const projection = apply(facts, initial);
        return {
          facts,
          projection,
          receiveMs: received - started,
          applyMs: performance.now() - received,
          mainMs: performance.now() - started,
          mainCpuMs: cpuMs(process.threadCpuUsage(cpu)),
        };
      },
      "receive-and-apply",
    );
  try {
    const { fixture } = await ready;
    if (options.fixtureRoot && !reuse) {
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const leaf = `event-${options.events - 2}`;
    const request = (
      leafEntryId: string,
      checkpoint?: SessionTranscriptMaintenanceCheckpoint,
    ): SessionTranscriptMaintenanceRead =>
      options.variant === "baseline"
        ? { operation: "custom-branch", customType: "openclaw.code-mode-store", leafEntryId }
        : { operation: "code-mode-store", leafEntryId, checkpoint };
    await call({ kind: "read", request: request(leaf) });
    const {
      projection: initialProjection,
      facts: { version },
    } = receive(new Map());
    assert.equal(initialProjection.size, 1);
    assert.equal(JSON.parse(initialProjection.get("key")!.json).step, options.events - 2);
    assert(version?.generation && version.rawSeq !== null);
    const checkpoint = {
      generation: version.generation,
      rawSeq: version.rawSeq,
      leafEntryId: leaf,
    };
    const phases: Record<string, unknown> = {};
    for (const phase of ["cold-replay", "unchanged", "append"] as const) {
      if (options.phase !== "all" && phase !== options.phase) {
        continue;
      }
      if (phase === "append") {
        await call({ kind: "append" });
      }
      const selected = request(
        phase === "append" ? "appended-store" : leaf,
        phase === "cold-replay" ? undefined : checkpoint,
      );
      const trace = await call({ kind: "read", request: selected, trace: true });
      const { projection: censusProjection } = receive(initialProjection);
      const expectedStep = phase === "append" ? options.events : options.events - 2;
      assert.equal(JSON.parse(censusProjection.get("key")!.json).step, expectedStep);
      assert.equal(censusProjection.size, 1);
      const expectedDigest = hash("sha256", JSON.stringify([...censusProjection]), "hex");
      globalThis.gc?.();
      await setImmediate();
      const inspector = new Session();
      if (options.allocations) {
        await startCollectedHeapSampling(inspector, 4096);
      }
      if (options.profileDir) {
        if (!options.allocations) {
          inspector.connect();
        }
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      await call({ kind: "begin", phase });
      const samples: Array<Record<string, number>> = [];
      const started = performance.now();
      const mainCpu = process.threadCpuUsage();
      for (let i = 0; i < options.iterations; i++) {
        const reply = await call({ kind: "read", request: selected });
        const { projection, receiveMs, applyMs, mainMs, mainCpuMs } = receive(initialProjection);
        assert.equal(hash("sha256", JSON.stringify([...projection]), "hex"), expectedDigest);
        samples.push({
          receiveMs,
          applyMs,
          mainMs,
          mainCpuMs,
          workerMs: reply.workerMs!,
          workerCpuMs: reply.workerCpuMs!,
          sendMs: reply.sendMs!,
          sendCpuMs: reply.sendCpuMs!,
        });
      }
      const elapsedMs = performance.now() - started;
      const mainThreadCpuMs = cpuMs(process.threadCpuUsage(mainCpu));
      const workerMetrics = await call({ kind: "end", phase });
      const allocatedBytes = options.allocations
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      if (options.profileDir) {
        const { profile } = await inspector.post("Profiler.stop");
        await mkdir(options.profileDir, { recursive: true });
        await writeFile(
          path.join(options.profileDir, `${options.variant}-${phase}-main.cpuprofile`),
          JSON.stringify(profile),
        );
      }
      if (options.allocations || options.profileDir) {
        inspector.disconnect();
      }
      phases[phase] = {
        trace,
        resultDigest: expectedDigest,
        elapsedMs,
        mainThreadCpuMs,
        allocatedBytes,
        workerAllocatedBytes: workerMetrics.allocatedBytes,
        ...Object.fromEntries(
          Object.keys(samples[0]!).map((key) => [
            key,
            summarize(samples.map((sample) => sample[key]!)),
          ]),
        ),
        memory: process.memoryUsage(),
        stalls: monitor.drain(),
      };
    }
    console.log(
      JSON.stringify({
        workload: "code-mode-store",
        options,
        fixture,
        hostLoad: loadavg(),
        sourceSha256: hash("sha256", await readFile(options.owner ?? ownerUrl), "hex"),
        phases,
      }),
    );
    await call({ kind: "close" });
  } finally {
    monitor.stop();
    port1.close();
    await worker.terminate();
    if (!options.fixtureRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function runWorker() {
  const { options, root, port, reuse } = workerData as {
    options: Options;
    root: string;
    port: MessagePort;
    reuse: boolean;
  };
  assert(parentPort);
  if (options.owner) {
    const source = await readFile(options.owner, "utf8");
    registerHooks({
      load(url, context, nextLoad) {
        return url === ownerUrl.href
          ? { format: "module-typescript", source, shortCircuit: true }
          : nextLoad(url, context);
      },
    });
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root };
  Object.assign(process.env, { OPENCLAW_STATE_DIR: root, OPENCLAW_HOME: root });
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  setRuntimeConfigSnapshot({
    logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "run.log") },
  });
  const agent = await import("../../src/state/openclaw-agent-db.js");
  const { runWithSqliteWorkerStateContext } =
    await import("../../src/infra/sqlite-worker-state-context.js");
  const { replaceSessionEntryInDatabase } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-mutation.js");
  const { replaceSqliteTranscriptEventsInTransaction, appendTranscriptEventsInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
  const { readSessionTranscriptMaintenance } =
    await import("../../src/config/sessions/session-transcript-maintenance-read.js");
  const { readThreadDiskReadBytes } = await import("../../src/infra/thread-disk-io.js");
  const { requireNodeSqlite } = await import("../../src/infra/node-sqlite.js");
  await runWithSqliteWorkerStateContext({ environment: env }, async () => {
    const location = { agentId: "main", env, path: path.join(root, "agent.sqlite") };
    const database = agent.openOpenClawAgentDatabase(location);
    const target = {
      ...location,
      storePath: database.path,
      sessionId: "synthetic-maintenance",
      sessionKey: "agent:main:synthetic-maintenance",
    };
    const timestamp = "2026-01-01T00:00:00.000Z";
    const cipher = createCipheriv(
      "aes-256-ctr",
      Buffer.from(hash("sha256", "maintenance-synthetic", "hex"), "hex"),
      Buffer.alloc(16),
    );
    const body = (bytes: number) =>
      cipher
        .update(Buffer.alloc(Math.ceil(bytes * 0.75)))
        .toString("base64")
        .slice(0, bytes);
    const header = (id: string) => ({
      type: "session",
      id,
      version: 3,
      timestamp,
      cwd: "/synthetic",
    });
    const storeEvent = (step: number, id: string, parentId: string | null) => {
      const event = {
        type: "custom",
        id,
        parentId,
        timestamp,
        customType: "openclaw.code-mode-store",
        data: { set: { key: { step, text: "" } }, delete: [], networkContent: { key: false } },
      };
      event.data.set.key.text = body(
        Math.max(0, options.eventBytes - Buffer.byteLength(JSON.stringify(event))),
      );
      return event;
    };
    const entries = [
      header(target.sessionId),
      ...Array.from({ length: options.events - 1 }, (_, i) =>
        storeEvent(i, `event-${i}`, i ? `event-${i - 1}` : null),
      ),
    ];
    agent.runOpenClawAgentWriteTransaction(() => {
      replaceSessionEntryInDatabase(database, target.sessionKey, {
        sessionId: target.sessionId,
        updatedAt: 1,
      });
      replaceSqliteTranscriptEventsInTransaction(database, target, entries, {
        rebuildProjectionSynchronously: true,
        scheduleProjectionReconcile: false,
      });
    }, location);
    const eventJsonBytes = entries.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    const perSessionBytes = Math.ceil(
      (options.backgroundMiB * 1024 ** 2) / Math.max(1, options.sessions - 1),
    );
    for (let index = reuse ? options.sessions : 1; index < options.sessions; index++) {
      const sessionId = `background-${index}`;
      const scope = { ...target, sessionId, sessionKey: `agent:main:${sessionId}` };
      const background = [
        header(sessionId),
        ...Array.from({ length: Math.ceil(perSessionBytes / 32768) }, (_, i) => ({
          type: "custom",
          id: `background-event-${i}`,
          parentId: i ? `background-event-${i - 1}` : null,
          timestamp,
          customType: "synthetic.background",
          data: { payload: body(32768) },
        })),
      ];
      agent.runOpenClawAgentWriteTransaction(() => {
        replaceSessionEntryInDatabase(database, scope.sessionKey, { sessionId, updatedAt: 1 });
        replaceSqliteTranscriptEventsInTransaction(database, scope, background, {
          rebuildProjectionSynchronously: true,
          scheduleProjectionReconcile: false,
        });
      }, location);
      if (index % 25 === 0) {
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      if (index % 250 === 0) {
        console.error(
          `Synthetic maintenance fixture: ${index}/${options.sessions - 1} background sessions`,
        );
      }
    }
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    parentPort!.postMessage(
      {
        fixture: {
          events: options.events,
          eventJsonBytes,
          sessions: options.sessions,
          backgroundMiB: options.backgroundMiB,
          databaseBytes: (await stat(database.path)).size,
        },
      },
      [],
    );
    const inspector = new Session();
    let done = false;
    while (!done) {
      const [command] = (await once(parentPort!, "message")) as [Command];
      try {
        if (command.kind === "close") {
          await agent.closeOpenClawAgentDatabasesAsync(root);
          const { closeOpenClawStateDatabaseAsync } =
            await import("../../src/state/openclaw-state-db.js");
          await closeOpenClawStateDatabaseAsync();
          done = true;
        } else if (command.kind === "append") {
          agent.runOpenClawAgentWriteTransaction(
            () =>
              appendTranscriptEventsInTransaction(
                database,
                target,
                [
                  {
                    type: "message",
                    id: "cron-turn",
                    parentId: `event-${options.events - 2}`,
                    timestamp,
                    message: { role: "user", content: "Synthetic scheduled dashboard update" },
                  },
                  storeEvent(options.events, "appended-store", "cron-turn"),
                ],
                { scheduleProjectionReconcile: false },
              ),
            location,
          );
        } else if (command.kind === "begin") {
          globalThis.gc?.();
          if (options.allocations) {
            await startCollectedHeapSampling(inspector, 4096);
          }
          if (options.profileDir) {
            if (!options.allocations) {
              inspector.connect();
            }
            await inspector.post("Profiler.enable");
            await inspector.post("Profiler.start");
          }
        } else if (command.kind === "end") {
          const allocatedBytes = options.allocations
            ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
          if (options.profileDir) {
            const { profile } = await inspector.post("Profiler.stop");
            await mkdir(options.profileDir, { recursive: true });
            await writeFile(
              path.join(
                options.profileDir,
                `${options.variant}-${command.phase}-worker.cpuprofile`,
              ),
              JSON.stringify(profile),
            );
          }
          if (options.allocations || options.profileDir) {
            inspector.disconnect();
          }
          parentPort!.postMessage({ allocatedBytes }, []);
          continue;
        } else {
          const metrics = { sqlTextBytes: 0, sqlBlobBytes: 0, sqlRows: 0 };
          const observe = (row: Record<string, unknown> | undefined) => {
            if (!row) {
              return;
            }
            metrics.sqlRows++;
            for (const value of Object.values(row)) {
              if (typeof value === "string") {
                metrics.sqlTextBytes += Buffer.byteLength(value);
              } else if (ArrayBuffer.isView(value)) {
                metrics.sqlBlobBytes += value.byteLength;
              }
            }
          };
          const prototype = requireNodeSqlite().StatementSync.prototype;
          // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below preserves each native statement receiver.
          const originals = { get: prototype.get, all: prototype.all, iterate: prototype.iterate };
          if (command.trace) {
            prototype.get = new Proxy(originals.get, {
              apply(fn, receiver, args) {
                const row = Reflect.apply(fn, receiver, args);
                observe(row);
                return row;
              },
            });
            prototype.all = new Proxy(originals.all, {
              apply(fn, receiver, args) {
                const rows = Reflect.apply(fn, receiver, args);
                rows.forEach(observe);
                return rows;
              },
            });
            prototype.iterate = new Proxy(originals.iterate, {
              apply(fn, receiver, args) {
                const rows: ReturnType<StatementSync["iterate"]> = Reflect.apply(
                  fn,
                  receiver,
                  args,
                );
                return (function* () {
                  for (const row of rows) {
                    observe(row);
                    yield row;
                  }
                })();
              },
            });
          }
          const beforeBytes = readThreadDiskReadBytes();
          const started = performance.now();
          const cpu = process.threadCpuUsage();
          let facts: SessionTranscriptMaintenanceFacts;
          try {
            facts = readSessionTranscriptMaintenance(database, target, command.request);
          } finally {
            if (command.trace) {
              Object.assign(prototype, originals);
            }
          }
          const workerCpuMs = cpuMs(process.threadCpuUsage(cpu));
          const workerMs = performance.now() - started;
          const afterBytes = readThreadDiskReadBytes();
          const replyBytes = command.trace ? serialize(facts).byteLength : undefined;
          const send = performance.now();
          const sendCpu = process.threadCpuUsage();
          port.postMessage(facts);
          parentPort!.postMessage(
            {
              workerMs,
              workerCpuMs,
              sendMs: performance.now() - send,
              sendCpuMs: cpuMs(process.threadCpuUsage(sendCpu)),
              replyBytes,
              physicalReadBytes:
                beforeBytes === undefined || afterBytes === undefined
                  ? undefined
                  : afterBytes - beforeBytes,
              ...(command.trace ? metrics : {}),
            },
            [],
          );
          continue;
        }
        parentPort!.postMessage({}, []);
      } catch (error) {
        parentPort!.postMessage(
          { error: error instanceof Error ? error.stack : String(error) },
          [],
        );
      }
    }
  });
}

if (workerData) {
  await runWorker();
}
