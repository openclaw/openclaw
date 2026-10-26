/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser target origin. */
/**
 * Callback entry-patch transport benchmark with an 11 KiB synthetic entry and a real worker.
 * Run from the prepared repository checkout:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-entry-patch-payload.ts \
 *   --iterations 5000 --pairs 6
 * Warm up each arm for 20,000 operations before measurement.
 * AB/BA pairs measure untraced CPU first, then separately sampled allocation (both threads,
 * including collected objects). Each operation receives preparation, clones the callback
 * input, makes a small merged update, and sends the commit through MessagePort. The worker
 * performs the unchanged production CAS. Startup, fixture creation, byte counting,
 * and exact-byte assertions precede measurement. SQL, persistence, admission and publication
 * are excluded: this is owner transport evidence, not Gateway latency or throughput proof.
 * Acceptance: identical reconstructed entry JSON and smaller commit payload; report absolute
 * main/worker CPU and allocation changes without using sampled CPU as a latency gate.
 * Defaults to a warm actor snapshot (hot SQL row, no duplicate cold JSON); --raw-row includes cold JSON.
 * The only protocol difference is the prepare handler's projection to sessionKey + entry;
 * the candidate commit naturally carries that smaller snapshot. The source hash of the
 * operation dispatcher records the matching production implementation.
 * Source capsule: this file, src/state/openclaw-agent-execution-operations.ts (hash only),
 * session-accessor.sqlite-entry-equality.ts and session-mutation-conflict-error.ts under
 * src/config/sessions, normalization-core's error-coercion.ts,
 * and the matching package manifest. For a tiny remote source capsule, transpile this closure
 * to ESM before running; startup is excluded. All source hashes are printed with the result.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "../../src/config/sessions/session-accessor.sqlite-entry-equality.js";
import type { SessionEntryPatchCommit } from "../../src/config/sessions/session-entry-patch.types.js";

type Arm = "base" | "candidate";
type Phase = "timing" | "allocation";
const { values } = parseArgs({
  options: {
    "raw-row": { type: "boolean", default: false },
    iterations: { type: "string", default: "5000" },
    pairs: { type: "string", default: "6" },
  },
});
const iterations = Number(values.iterations);
const warmupIterations = 20_000;
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(global.gc, "run with --expose-gc");
const equalityUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-entry-equality.ts",
  import.meta.url,
);

function fixture(): SqliteLifecycleTargetSnapshot {
  const entry = {
    sessionId: "synthetic-team-session",
    updatedAt: 1_800_000_000_000,
    sessionStartedAt: 1_799_999_990_000,
    label: "Synthetic finished subagent",
    model: "mock-model",
    modelProvider: "mock",
    inputTokens: 1_234,
    outputTokens: 567,
    totalTokens: 1_801,
    skillsSnapshot: {
      prompt: "Synthetic tool instructions for a Team-shaped session. ".repeat(200),
      skills: [{ name: "synthetic", requiredEnv: ["SYNTHETIC_SETTING"] }],
    },
  };
  const { skillsSnapshot, ...hot } = entry;
  return [
    {
      sessionKey: "agent:main:subagent:synthetic-team-session",
      entry,
      row: {
        session_key: "agent:main:subagent:synthetic-team-session",
        current_session_id: entry.sessionId,
        updated_at: entry.updatedAt,
        entry_json: JSON.stringify(hot),
        skills_snapshot_json: values["raw-row"] ? JSON.stringify(skillsSnapshot) : null,
      },
      sideTables: { memberIdsJson: "[]", hasBoard: false },
    },
  ];
}

function planned(prepared: SqliteLifecycleTargetSnapshot): SessionEntryPatchCommit {
  const writeBase = prepared[0]!.entry;
  // The real callback receives a detached entry; this common work belongs to both arms.
  const callbackEntry = structuredClone(writeBase);
  const patch = { label: `${callbackEntry.label}: patched`, updatedAt: writeBase.updatedAt + 1 };
  return {
    selection: { kind: "entry", sessionKey: prepared[0]!.sessionKey, exact: false },
    prepared,
    sessionKey: prepared[0]!.sessionKey,
    writeBase,
    next: { ...writeBase, ...patch },
    operationLabel: "session-entry.patch",
    validateCanonicalKeys: true,
  };
}

function allocationSize(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocationSize(child), 0);
}

async function sampler(phase: Phase) {
  if (phase !== "allocation") {
    return async () => undefined;
  }
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4_096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  return async () => {
    const { profile } = await session.post("HeapProfiler.stopSampling");
    session.disconnect();
    return allocationSize(profile.head);
  };
}

if (!isMainThread) {
  assert(parentPort);
  const arm = workerData as Arm;
  const fresh = fixture();
  let startCpu = process.threadCpuUsage();
  let finishSample: () => Promise<number | undefined> = async () => undefined;
  const fail = (error: unknown) => {
    process.nextTick(() => {
      throw error;
    });
  };
  parentPort.on("message", (message) => {
    switch (message.kind) {
      case "prepare":
        parentPort!.postMessage(
          arm === "base" ? fresh : fresh.map(({ sessionKey, entry }) => ({ sessionKey, entry })),
        );
        break;
      case "commit": {
        const input = message.input as SessionEntryPatchCommit;
        assertLifecycleTargetSnapshotUnchanged(input.prepared, fresh, input.operationLabel);
        const next = input.next;
        parentPort!.postMessage(message.exact ? JSON.stringify(next) : next?.updatedAt);
        break;
      }
      case "begin":
        global.gc!();
        void sampler(message.phase)
          .then((finish) => {
            finishSample = finish;
            startCpu = process.threadCpuUsage();
            parentPort!.postMessage(null);
          })
          .catch(fail);
        break;
      case "end": {
        const cpu = process.threadCpuUsage(startCpu);
        void finishSample()
          .then((allocationBytes) => {
            parentPort!.postMessage({ cpuUs: cpu.user + cpu.system, allocationBytes });
          })
          .catch(fail);
        break;
      }
    }
  });
} else {
  const sourcePaths = [
    fileURLToPath(new URL("./session-entry-patch-payload.ts", import.meta.url)),
    fileURLToPath(equalityUrl),
    fileURLToPath(
      new URL("../../src/state/openclaw-agent-execution-operations.ts", import.meta.url),
    ),
  ];
  const sourceHashes = Object.fromEntries(
    sourcePaths.map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  const workers = new Map<Arm, Worker>();
  const rpc = <T>(worker: Worker, message: object): Promise<T> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        worker.off("message", onMessage);
        reject(error);
      };
      const onMessage = (reply: T) => {
        worker.off("error", onError);
        resolve(reply);
      };
      worker.once("error", onError);
      worker.once("message", onMessage);
      worker.postMessage(message);
    });
  const operation = async (arm: Arm, exact = false) => {
    const worker = workers.get(arm)!;
    const prepared = await rpc<SqliteLifecycleTargetSnapshot>(worker, { kind: "prepare" });
    return rpc(worker, { kind: "commit", input: planned(prepared), exact });
  };
  try {
    for (const arm of ["base", "candidate"] as const) {
      workers.set(
        arm,
        new Worker(pathToFileURL(fileURLToPath(import.meta.url)), {
          workerData: arm,
          argv: process.argv.slice(2),
        }),
      );
    }
    assert.equal(await operation("base", true), await operation("candidate", true));
    for (let index = 0; index < warmupIterations; index++) {
      await operation("base");
      await operation("candidate");
    }
    const snapshot = fixture();
    const baseInput = planned(snapshot);
    const projected = snapshot.map(({ sessionKey, entry }) => ({ sessionKey, entry }));
    const payloadBytes = {
      entry: serialize(snapshot[0]!.entry).byteLength,
      basePrepare: serialize(snapshot).byteLength,
      candidatePrepare: serialize(projected).byteLength,
      baseCommit: serialize(baseInput).byteLength,
      candidateCommit: serialize(planned(projected)).byteLength,
    };
    console.log(
      JSON.stringify({
        kind: "fixture",
        node: process.version,
        rawRow: values["raw-row"],
        iterations,
        warmupIterations,
        pairs,
        sourceHashes,
        payloadBytes,
      }),
    );
    for (const phase of ["timing", "allocation"] as const) {
      for (let pair = 0; pair < pairs; pair++) {
        const order: Arm[] = pair % 2 ? ["candidate", "base"] : ["base", "candidate"];
        for (const arm of order) {
          const worker = workers.get(arm)!;
          await rpc(worker, { kind: "begin", phase });
          global.gc();
          const finishSample = await sampler(phase);
          const loadBefore = loadavg();
          const startCpu = process.threadCpuUsage();
          const start = performance.now();
          for (let index = 0; index < iterations; index++) {
            await operation(arm);
          }
          const elapsedMs = performance.now() - start;
          const cpu = process.threadCpuUsage(startCpu);
          const allocationBytes = await finishSample();
          const workerMetrics = await rpc<{ cpuUs: number; allocationBytes?: number }>(worker, {
            kind: "end",
          });
          console.log(
            JSON.stringify({
              kind: "arm",
              phase,
              pair,
              arm,
              iterations,
              elapsedMs,
              mainCpuUs: cpu.user + cpu.system,
              workerCpuUs: workerMetrics.cpuUs,
              mainAllocationBytes: allocationBytes,
              workerAllocationBytes: workerMetrics.allocationBytes,
              loadBefore,
              loadAfter: loadavg(),
              memory: process.memoryUsage(),
            }),
          );
        }
      }
    }
  } finally {
    await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  }
}
