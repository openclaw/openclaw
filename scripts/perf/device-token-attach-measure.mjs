/**
 * node --import ./scripts/tsx.mjs scripts/perf/device-token-attach-measure.mjs \
 *   --output .local/buf652-token/run --base 65a34e0cdb0f [--mode setup|base|compare]
 * [--candidate WORKTREE] [--calls 3000] [--pairs 5] [--contended-calls 5] [--hold-ms 200]
 * Exact adjacent owner modules share real publication, lock, worker, and SQLite
 * dependencies. Fresh synthetic state only; no built-in patches or token output.
 * Idle and controlled-lock-contention calls report wall/main/process CPU with
 * per-arm host load and latency distribution. Holder release happens in a sibling
 * async context; its remaining lifetime is outside candidate call timing.
 * Controlled contention demonstrates queue sensitivity, not the cause of any
 * production connect tail. setup validates source worker execution without timing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    base: { type: "string", default: "65a34e0cdb0f" },
    candidate: { type: "string", default: "WORKTREE" },
    mode: { type: "string", default: "compare" },
    calls: { type: "string", default: "3000" },
    pairs: { type: "string", default: "5" },
    "contended-calls": { type: "string", default: "5" },
    "hold-ms": { type: "string", default: "200" },
  },
});
assert(values.output, "--output must name a fresh synthetic directory");
assert(["setup", "base", "compare"].includes(values.mode));
const counts = Object.fromEntries(
  ["calls", "pairs", "contended-calls", "hold-ms"].map((key) => [key, Number(values[key])]),
);
assert(Object.values(counts).every((number) => Number.isSafeInteger(number) && number > 0));
assert(counts.pairs >= 5 || values.mode === "setup", "Use at least five pairs");
const output = path.resolve(values.output);
mkdirSync(output, { mode: 0o700 });
const stateDir = path.join(output, "state");
mkdirSync(stateDir, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const report = [],
  emit = (row) => {
    report.push(row);
    console.log(JSON.stringify(row));
  };
const temporaryFiles = [];
process.once("exit", () => temporaryFiles.forEach((file) => rmSync(file, { force: true })));
const sourceFile = "src/infra/device-pairing-tokens.ts",
  owners = {};
for (const side of values.mode === "compare" ? ["base", "candidate"] : ["base"]) {
  const ref = side === "base" ? values.base : values.candidate;
  const source =
    ref === "WORKTREE"
      ? readFileSync(sourceFile, "utf8")
      : execFileSync("git", ["show", `${ref}:${sourceFile}`], {
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        });
  const file = path.resolve(path.dirname(sourceFile), `.token-attach-${process.pid}-${side}.ts`);
  writeFileSync(file, source, { flag: "wx" });
  temporaryFiles.push(file);
  owners[side] = {
    ensure: (await import(pathToFileURL(file).href)).ensureDeviceToken,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}
const store = await import("../../src/infra/device-pairing-store.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const { loadPairedDevicePairingStoreRecordReadOnly } =
  await import("../../src/infra/device-pairing-store-readonly.ts");
const { withDevicePairingLock } = await import("../../src/infra/device-pairing-lock.ts");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.ts");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.ts");
const database = state.openOpenClawStateDatabase();
const valid = { deviceId: "synthetic-paired", role: "operator", scopes: ["operator.read"] };
const missing = { ...valid, deviceId: "synthetic-unpaired" };
const token = {
  token: "synthetic-unused-device-token",
  role: "operator",
  scopes: ["operator.read"],
  createdAtMs: 1,
};
const paired = {
  deviceId: valid.deviceId,
  publicKey: "synthetic-public-key",
  roles: ["operator"],
  scopes: ["operator.read"],
  approvedScopes: ["operator.read"],
  tokens: { operator: token },
  createdAtMs: 1,
  approvedAtMs: 1,
};
const persisted = () =>
  JSON.stringify({
    rows: store.readDevicePairingStoreStateFromDatabase(database.db),
    revision: store.readPairedDevicePairingSnapshotFromDatabase(database.db).revision,
  });
const equivalent = (result, input) =>
  input === missing
    ? result === null
    : result?.token === token.token &&
      result?.role === token.role &&
      JSON.stringify(result.scopes) === JSON.stringify(token.scopes);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function holdLock() {
  const entered = deferred(),
    release = deferred();
  const holding = withDevicePairingLock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const started = performance.now();
  let observedMs = 0;
  const timer = setTimeout(() => {
    observedMs = performance.now() - started;
    release.resolve();
  }, counts["hold-ms"]);
  return {
    holding,
    observedMs: () => observedMs,
    release: () => {
      clearTimeout(timer);
      release.resolve();
    },
  };
}
try {
  store.persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: { [valid.deviceId]: paired } },
    stateDir,
    "both",
  );
  assert(
    (await loadPairedDevicePairingStoreRecordReadOnly(missing.deviceId)) === null,
    "Missing row publication was not prepared",
  );
  assert(
    await loadPairedDevicePairingStoreRecordReadOnly(valid.deviceId),
    "Valid row publication was not prepared",
  );
  for (const owner of Object.values(owners)) {
    for (const input of [missing, valid]) {
      assert(equivalent(await owner.ensure(input), input), "Worker setup changed token behavior");
    }
  }
  const before = persisted();
  emit({
    protocol: "device-token-attach-v1",
    mode: values.mode,
    base: values.base,
    candidate: values.candidate,
    counts,
    node: process.version,
    sourceWorkerSetup: "passed",
    sourceHashes: Object.fromEntries(
      Object.entries(owners).map(([side, owner]) => [side, owner.hash]),
    ),
  });
  // Attribution is outside measured calls and uses the owner's existing diagnostics.
  for (const [side, owner] of Object.entries(owners)) {
    const requests = [];
    const stop = onWorkerRequestMetrics(
      (kind, requestClass, phase, queueDepth, queueWaitMs, durationMs, timing) => {
        if (requestClass === "devicePairing.ensureToken") {
          requests.push({ kind, requestClass, phase, queueDepth, queueWaitMs, durationMs, timing });
        }
      },
    );
    try {
      assert((await owner.ensure(missing)) === null, "Attribution call changed missing behavior");
    } finally {
      stop();
    }
    emit({ attribution: "missing-device-worker-request", side, requests });
  }
  if (values.mode !== "setup") {
    for (const workload of ["missing-idle", "valid-idle", "missing-contended", "valid-contended"]) {
      const input = workload.startsWith("missing") ? missing : valid;
      const contended = workload.endsWith("contended");
      const calls = contended ? counts["contended-calls"] : counts.calls;
      for (const owner of Object.values(owners)) {
        for (let warm = 0; warm < 20; warm++) {
          assert(equivalent(await owner.ensure(input), input), "Warm call changed token behavior");
        }
      }
      for (let pair = 0; pair < counts.pairs; pair++) {
        const sides = Object.keys(owners);
        if (pair % 2) {
          sides.reverse();
        }
        for (const side of sides) {
          const durations = [],
            holderDurations = [],
            hostLoad = loadavg();
          let threadUs = 0,
            processUs = 0;
          for (let iteration = 0; iteration < calls; iteration++) {
            const holder = contended ? await holdLock() : undefined;
            try {
              const cpu = process.cpuUsage(),
                thread = process.threadCpuUsage(),
                started = performance.now();
              const result = await owners[side].ensure(input);
              durations.push(performance.now() - started);
              const threadUsed = process.threadCpuUsage(thread),
                used = process.cpuUsage(cpu);
              threadUs += threadUsed.user + threadUsed.system;
              processUs += used.user + used.system;
              assert(equivalent(result, input), "Measured call changed token behavior");
            } finally {
              if (holder) {
                await holder.holding;
                holderDurations.push(holder.observedMs());
                holder.release();
              }
            }
          }
          const sorted = durations.toSorted((a, b) => a - b);
          const held = holderDurations.toSorted((a, b) => a - b);
          emit({
            workload,
            pair,
            side,
            calls,
            hostLoad,
            hostLoadEnd: loadavg(),
            holder: contended
              ? {
                  owner: "withDevicePairingLock",
                  requestedMs: counts["hold-ms"],
                  observedMedianMs: held[Math.floor(held.length / 2)],
                  observedMaxMs: held.at(-1),
                }
              : null,
            wallMsPerCall: durations.reduce((sum, value) => sum + value, 0) / calls,
            wallMedianMs: sorted[Math.floor(sorted.length / 2)],
            wallMaxMs: sorted.at(-1),
            mainThreadCpuUsPerCall: threadUs / calls,
            processCpuUsPerCall: processUs / calls,
            rssBytes: process.memoryUsage().rss,
            heapUsedBytes: process.memoryUsage().heapUsed,
          });
          assert(persisted() === before, "Pairing rows or revision changed during measurement");
        }
      }
    }
  }
  assert(persisted() === before, "Pairing rows or revision changed during setup");
  emit({
    proof: "pairing-rows-and-revision-unchanged",
    tokenResults: "missing-null-and-valid-reused",
  });
} finally {
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await state.closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
