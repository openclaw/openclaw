/**
 * Synthetic policy-mutation receipt capture and native MessagePort delivery.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/exec-approvals-receipt-measure.ts \
 *   --arm base --iterations 5000
 * Repeat with --arm candidate, alternating AB/BA; measure allocation separately
 * with --allocation. Setup captures an actual mutation-owner receipt for 200
 * synthetic allowlist rows. Base reconstructs the previous independent file copy;
 * candidate shares that same committed postimage. Both preserve all policy data.
 * Measured CPU/allocation includes production receipt capture plus MessagePort
 * send/receive in one isolate; SQL, setup, and authority admission are excluded.
 * This is a mutation-receipt benchmark, not authorization-usage or Gateway load.
 * --workload usage measures ordinary authorization replies separately using the
 * 40-agent/20-rule census fixture. Base includes the old raw/hash/path snapshot;
 * candidate includes only its consumed file. Its commit receipt stays unchanged.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ExecApprovalsFile } from "../../src/infra/exec-approvals-core.js";
import { captureSqliteWorkerCommitReceipt } from "../../src/infra/sqlite-worker-operation-settlement.js";
import type { WorkerWriteOperationContext } from "../../src/state/worker-operation-registry.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    iterations: { type: "string", default: "5000" },
    allocation: { type: "boolean", default: false },
    workload: { type: "string", default: "mutation" },
  },
});
assert(values.arm === "base" || values.arm === "candidate", "Choose --arm base or candidate");
assert(values.workload === "mutation" || values.workload === "usage");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/exec-receipts-"));
process.env.OPENCLAW_STATE_DIR = root;
const state = await import("../../src/state/openclaw-state-db.js");
const admission = await import("../../src/infra/sqlite-worker-operation-admission.js");
const { execPolicyMutationOperations } =
  await import("../../src/infra/exec-approvals-mutation.worker.js");
const { execApprovalsPublication } = await import("../../src/infra/exec-approvals-publication.js");
const { commitExecAuthorizationsInWorker } =
  await import("../../src/infra/exec-approvals-authorization.worker.js");
const { writeExecApprovalsConfigRow, snapshotFromExecApprovalsDatabase } =
  await import("../../src/infra/exec-approvals-sqlite.js");
const options = { path: path.join(root, "openclaw.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
let facts: unknown;
let ordinaryReply: unknown;
try {
  const database = state.openOpenClawStateDatabase(options);
  const owner = admission.createSqliteWorkerOperationAdmission((_request, grant) => {
    assert(grant());
  });
  admission.observeSqliteWorkerCommittedFacts(owner, (committed) => {
    facts = committed.facts;
  });
  const context: WorkerWriteOperationContext = {
    open: () => database,
    stateOptions: () => options,
    writeAdmitted: () => {
      throw new Error("Fixture mutation owns its admission");
    },
    write: (operation, transaction) =>
      state.runOpenClawStateWriteTransaction(operation, { ...options, database }, transaction),
  };
  const file: ExecApprovalsFile = {
    version: 1,
    agents: {
      main: {
        allowlist: Array.from({ length: 200 }, (_, index) => ({
          id: `synthetic-${index}`,
          pattern: `/synthetic/tools/command-${index}`,
        })),
      },
    },
  };
  const wait = Atomics.wait;
  try {
    // Setup only: service the synthetic host's admission while its local writer waits.
    Atomics.wait = () => {
      owner.service();
      return "ok";
    };
    if (values.workload === "mutation") {
      admission.withSqliteWorkerOperationAdmission({ port: owner.port }, () =>
        execPolicyMutationOperations["execApprovals.update"](
          { update: { kind: "replace", file } },
          context,
        ),
      );
    } else {
      const entry = { id: "synthetic-echo", pattern: "/usr/bin/echo" };
      const agents = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          index === 0 ? "main" : `synthetic-agent-${index}`,
          {
            allowlist: Array.from({ length: 20 }, (_entry, rule) =>
              rule === 0
                ? entry
                : {
                    id: `synthetic-${rule}`,
                    pattern: `/usr/bin/synthetic-${rule}`,
                  },
            ),
          },
        ]),
      );
      writeExecApprovalsConfigRow({ db: database.db, file: { version: 1, agents } });
      const result = admission.withSqliteWorkerOperationAdmission({ port: owner.port }, () =>
        commitExecAuthorizationsInWorker(
          {
            items: [
              {
                agentId: "main",
                command: "echo synthetic",
                matches: [entry],
                authorization: {
                  source: "current-policy",
                  security: "allowlist",
                  ask: "on-miss",
                  allowlistSatisfied: true,
                },
              },
            ],
          },
          context,
        ),
      );
      assert(result[0]?.ok);
      const snapshot = snapshotFromExecApprovalsDatabase(database.db);
      assert.deepEqual(result[0].file, snapshot.file);
      ordinaryReply = values.arm === "base" ? [{ ok: true, snapshot }] : result;
    }
    owner.service();
  } finally {
    Atomics.wait = wait;
    owner.finish();
  }
} finally {
  await state.closeOpenClawStateDatabaseAsync();
  rmSync(root, { recursive: true });
}
assert(isRecord(facts));
if (values.workload === "mutation") {
  const postimage = execApprovalsPublication.readReceipt(facts.execFacts).facts.get("current");
  assert(postimage?.kind === "postimage");
  assert.deepEqual(facts.file, postimage.value.file);
  facts.file = values.arm === "base" ? structuredClone(postimage.value.file) : postimage.value.file;
}
const payload = captureSqliteWorkerCommitReceipt(facts);
assert(payload.kind === "inline");
const { port1, port2 } = new MessageChannel();
const inspector = new Session();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
function run(count: number) {
  let last: unknown;
  for (let index = 0; index < count; index++) {
    if (values.workload === "mutation") {
      const captured = captureSqliteWorkerCommitReceipt(facts);
      assert(captured.kind === "inline");
      port1.postMessage(captured.facts);
      last = receiveMessageOnPort(port2)?.message;
    } else {
      port1.postMessage(serialize(ordinaryReply));
      const received: unknown = receiveMessageOnPort(port2)?.message;
      assert(received instanceof Uint8Array);
      last = deserialize(received);
    }
  }
  assert.deepEqual(last, values.workload === "mutation" ? facts : ordinaryReply);
}
try {
  run(1000);
  global.gc();
  await setImmediate();
  const pauses: number[] = [];
  const observer = new PerformanceObserver((batch) => {
    pauses.push(...batch.getEntries().map((entry) => entry.duration));
  });
  observer.observe({ entryTypes: ["gc"] });
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  await setImmediate();
  pauses.push(...observer.takeRecords().map((entry) => entry.duration));
  observer.disconnect();
  const profile = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      arm: values.arm,
      workload: values.workload,
      mode: values.allocation ? "allocation" : "timing",
      iterations,
      rows: values.workload === "mutation" ? 200 : 800,
      receiptBytes: payload.payloadBytes,
      replyBytes: values.workload === "usage" ? serialize(ordinaryReply).byteLength : undefined,
      elapsedMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      allocatedBytesPerOperation: profile ? allocated(profile.head) / iterations : undefined,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, pause) => sum + pause, 0),
        maxMs: Math.max(0, ...pauses),
      },
      hostLoad,
    }),
  );
} finally {
  inspector.disconnect();
  port1.close();
  port2.close();
}
