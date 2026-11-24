// Synthetic owner proof; seed with session-actor-retention-seed.ts or transcript-broadcast-measure.ts.
// node --import ./scripts/tsx.mjs scripts/perf/session-actor-retention-measure.ts \
//   --state-dir <synthetic-state> --output <new-directory> --sessions 4 --reads 1400 --writes 280 --snapshot
// Repeat with --sessions 140 for byte pressure. Alternate --baseline-dir <original-source-tree>
// and candidate in fresh processes. Allocation and traced promotion are separate passes:
// --allocation includes collected objects; --trace-gc emits isolate-matched promotion traces.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    "start-at": { type: "string" },
    sessions: { type: "string", default: "4" },
    reads: { type: "string", default: "1200" },
    writes: { type: "string", default: "200" },
    snapshot: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    "trace-gc": { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const count = (raw: string, minimum = 0) => {
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value >= minimum, "Invalid workload count");
  return value;
};
const sessions = count(values.sessions, 1);
const reads = count(values.reads);
const writes = count(values.writes);
assert(writes % (2 * sessions) === 0, "--writes must contain complete on/off rounds");
await mkdir(output, { recursive: true });
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_BENCH_RETAINED_WORKER_DIR: output,
  ...(values.allocation ? { OPENCLAW_BENCH_SAMPLE_ALLOCATION: "1" } : {}),
  ...(values["trace-gc"] ? { OPENCLAW_BENCH_TRACE_GC: "1" } : {}),
  ...(values["baseline-dir"]
    ? { OPENCLAW_BENCH_BASELINE_DIR: path.resolve(values["baseline-dir"]) }
    : {}),
};
await import("./worker-retained-heap-preload.ts");
const databaseOwner = await import("../../src/state/openclaw-agent-db.js");
const { readOpenClawAgentDatabaseIdentity } =
  await import("../../src/state/openclaw-agent-db-identity.js");
const { createSessionActorFactory } =
  await import("../../src/config/sessions/session-actor-durable.js");
const { createSessionActorReplica } =
  await import("../../src/config/sessions/session-actor-replica.js");
const options = { agentId: "main", env: process.env };
const database = databaseOwner.openOpenClawAgentDatabase(options);
const identity = readOpenClawAgentDatabaseIdentity(database);
assert(typeof identity.identity === "string");
const factory = createSessionActorFactory({ ...options, path: database.path });
const actors: Array<Awaited<ReturnType<typeof factory.acquire>>> = [];
const replicas: Array<ReturnType<typeof createSessionActorReplica>> = [];
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const entryBytes: number[] = [];
const readMs: number[] = [];
const writeMs: number[] = [];
const epochs: string[] = [];
let rehydrations = 0;
const runId = values["start-at"] ?? randomUUID();
type Worker = { prefix: string; commandPath: string };
const command = async (worker: Worker, operation: string) => {
  const id = `${operation}-${Date.now()}`;
  await writeFile(`${worker.commandPath}.tmp`, JSON.stringify({ id, operation }));
  await rename(`${worker.commandPath}.tmp`, worker.commandPath);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse(await readFile(`${worker.prefix}.${id}.json`, "utf8"));
      assert.equal(reply.ok, true);
      return reply;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await delay(25);
    }
  }
  throw new Error(`Worker ${operation} deadline expired`);
};
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
};
try {
  for (let index = 0; index < sessions; index++) {
    const actor = await factory.acquire(
      {
        sessionKey: `agent:main:transcript-broadcast-measure-child-${index}`,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: database.path,
        },
      },
      lifetime,
    );
    assert(!("kind" in actor));
    actors.push(actor);
    assert(actor.target.database.kind === "file");
    replicas.push(
      createSessionActorReplica({
        target: { sessionKey: actor.target.sessionKey, database: actor.target.database },
        lifetime,
        currentGeneration: () => undefined,
      }),
    );
    const facts = await actor.read(authority);
    assert(facts.entry?.skillsSnapshot, "Seed real turns before measuring actor retention");
    entryBytes.push(Buffer.byteLength(JSON.stringify(facts.entry)));
    epochs.push(facts.version.epoch);
  }
  const patch = async (index: number) => {
    const actor = actors[index % sessions]!;
    const result = await actor.patch(
      {
        commandId: `retention-${runId}-${index}`,
        phaseId: "retention",
        reducers: [
          { kind: "group-intro", needsSystemIntro: Math.floor(index / sessions) % 2 === 0 },
        ],
      },
      authority,
    );
    assert.equal(result.kind, "committed");
    const slot = index % sessions;
    rehydrations += Number(epochs[slot] !== result.receipt.postimage.version.epoch);
    epochs[slot] = result.receipt.postimage.version.epoch;
  };
  for (let index = 0; index < 2 * sessions; index++) {
    await patch(index + 2 * sessions);
  }
  const workers: Worker[] = [];
  for (const file of await readdir(output)) {
    if (file.endsWith(".ready.json")) {
      const ready = JSON.parse(await readFile(path.join(output, file), "utf8"));
      if (ready.script.startsWith("sqlite-store.worker.")) {
        workers.push({
          prefix: path.join(output, file.slice(0, -".ready.json".length)),
          commandPath: ready.commandPath,
        });
      }
    }
  }
  assert.equal(workers.length, 1, "Expected one native session writer");
  const worker = workers[0]!;
  const before = await command(worker, "collect");
  const warmupRehydrations = rehydrations;
  rehydrations = 0;
  const initialLoad = loadavg();
  console.log("PHASE warmed");
  if (values["start-at"]) {
    const startAt = count(values["start-at"], 1);
    assert(startAt > Date.now(), "Missed synchronized start");
    await delay(startAt - Date.now());
  }
  const startedAt = Date.now();
  await command(worker, "start");
  for (let index = 0; index < reads; index++) {
    // Invalidate only the host replica; measure a read of the warm native actor.
    replicas[index % sessions]!.invalidate();
    const started = performance.now();
    const facts = await actors[index % sessions]!.read(authority);
    readMs.push(performance.now() - started);
    assert(facts.entry?.skillsSnapshot);
    const slot = index % sessions;
    rehydrations += Number(epochs[slot] !== facts.version.epoch);
    epochs[slot] = facts.version.epoch;
  }
  for (let index = 0; index < writes; index++) {
    const started = performance.now();
    await patch(index + 4 * sessions);
    writeMs.push(performance.now() - started);
  }
  const timed = await command(worker, "stop");
  const after = await command(worker, "collect");
  const snapshot = values.snapshot ? await command(worker, "snapshot") : undefined;
  const result = {
    node: process.version,
    sessions,
    load: { before: initialLoad, after: loadavg() },
    warmupRehydrations,
    rehydrations,
    entryBytes,
    startedAt,
    reads: distribution(readMs),
    writes: distribution(writeMs),
    before,
    timed,
    after,
    snapshot,
  };
  await writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  for (const replica of replicas) {
    replica.close();
  }
  for (const actor of actors) {
    await actor.release();
  }
  await databaseOwner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
  const lifecycle = await import("../../src/shared/global-singleton.js");
  await lifecycle.drainGlobalSingletonLifecycleState();
}
