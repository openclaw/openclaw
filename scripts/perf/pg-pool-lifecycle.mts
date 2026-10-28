// Node: node --import ./scripts/tsx.mjs scripts/perf/pg-pool-lifecycle.mts --mode <case>
// Bun: bun scripts/perf/pg-pool-lifecycle.mts --mode <case>
// PGFOOTPRINT_DSN must name an owned synthetic PostgreSQL instance. Reports omit data and DSNs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  type MessagePort,
} from "node:worker_threads";
import { Client } from "pg";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../src/infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../../src/infra/database-engine/context.js";
import type { StoreSchema } from "../../src/infra/database-engine/contract.js";
import type { DatabaseEngineSelection } from "../../src/infra/database-engine/types.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { PostgresSyncConnection } from "../../src/infra/postgres-sync/connection.js";
import { bindPostgresPool } from "../../src/infra/postgres-sync/pool-state.js";
import {
  closePostgresPool,
  createPostgresPoolEndpoints,
  postgresPoolTransferList,
  preparePostgresPoolForUpdate,
} from "../../src/infra/postgres-sync/pool.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../src/infra/runtime-worker-url.js";
import type { SqliteWorkerStore } from "../../src/infra/sqlite-worker-contract.js";
import type { PoolFixtureOperations } from "./pg-pool-broker.fixture.mjs";

type Fault = {
  kind: "fault";
  port: MessagePort;
  started?: SharedArrayBuffer;
  index?: string;
};
type Child = { kind: "transfer"; depth: number } | Fault | { kind: "task" };
type Task = { sleep: boolean; marker?: string };
type TaskReply = { ok: true } | { ok: false; error: string };
const child: Child | undefined = isMainThread ? undefined : workerData;
const self = new URL(import.meta.url);
const dsn = process.env.PGFOOTPRINT_DSN;
if (!dsn) {
  throw new Error("PGFOOTPRINT_DSN must name an owned synthetic PostgreSQL fixture");
}
const selection: DatabaseEngineSelection = {
  effectiveEngines: {
    state: "postgres",
    agent: "postgres",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  },
  postgres: { connection: dsn, schemaPrefix: "pool_fixture" },
};

function spawnWorker(data: Child, transferList: MessagePort[] = []) {
  return new Worker(self, {
    workerData: data,
    transferList,
    execArgv: resolveRuntimeWorkerThreadExecArgv(self),
  });
}
function transferredWorker(depth: number) {
  return withDatabaseEngineSelection(selection, () => {
    const postgresPool = createPostgresPoolEndpoints();
    return new Worker(self, {
      workerData: { kind: "transfer", depth, postgresPool },
      transferList: postgresPoolTransferList(postgresPool),
      execArgv: resolveRuntimeWorkerThreadExecArgv(self),
    });
  });
}
function open(namespace = "public", options?: { statementTimeoutMs: number }) {
  const anchor = openNodeSqliteDatabase(":memory:");
  try {
    const db = withEngineStoreAdmission(
      () => new PostgresSyncConnection(dsn!, namespace, anchor, randomUUID(), options),
    );
    return {
      db,
      close: () => {
        db.close();
        anchor.close();
      },
    };
  } catch (error) {
    anchor.close();
    throw error;
  }
}
function check(db: PostgresSyncConnection) {
  assert.equal(withEngineStoreAdmission(() => db.prepare("SELECT 1 AS ok").get())?.ok, 1);
}
function report(value: Record<string, unknown>) {
  console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", ...value }));
}
async function waitMessage(worker: Worker) {
  return (await once(worker, "message"))[0] as unknown;
}
async function faultWorker(index = 0, extra: Omit<Fault, "kind" | "port"> = {}) {
  const endpoints = withDatabaseEngineSelection(selection, () => createPostgresPoolEndpoints());
  assert.ok(endpoints);
  const service = endpoints.services[index];
  assert.ok(service);
  const port = service.port;
  for (const [i, endpoint] of endpoints.services.entries()) {
    if (i !== index) {
      endpoint.port.close();
    }
  }
  const worker = spawnWorker({ kind: "fault", port, ...extra }, [port]);
  assert.equal(await waitMessage(worker), "ready");
  return worker;
}
function poolSnapshot() {
  const endpoints = withDatabaseEngineSelection(selection, () => createPostgresPoolEndpoints());
  assert.ok(endpoints);
  for (const endpoint of endpoints.services) {
    endpoint.port.close();
  }
  const service = endpoints.services.at(0);
  assert.ok(service);
  return {
    signal: new Int32Array(service.signal),
    allocations: new Uint32Array(endpoints.allocation),
  };
}
function assertPoolReplaced(before: ReturnType<typeof poolSnapshot>) {
  const after = poolSnapshot();
  assert.equal(Atomics.load(before.signal, 1), 1);
  assert.equal(Atomics.load(after.signal, 1), 0);
  assert.notEqual(before.signal.buffer, after.signal.buffer);
  assert.equal(Atomics.load(after.allocations, 0), 5);
}

const sourceSql = `CREATE TABLE schema_meta (schema_version BIGINT NOT NULL);
  INSERT INTO schema_meta VALUES (1);
  CREATE TABLE pool_fixture (id BIGINT PRIMARY KEY, value TEXT NOT NULL);`;
function schema(target: boolean, index: string, pause = false): StoreSchema {
  const destination = `${sourceSql.replace("VALUES (1)", "VALUES (2)")}
    CREATE INDEX ${index}_one ON pool_fixture (value);
    CREATE INDEX ${index}_two ON pool_fixture (id, value);`;
  return {
    id: "state",
    version: target ? 2 : 1,
    sqlite: "",
    postgres: target ? destination : sourceSql,
    postgresMigrations: target
      ? [
          {
            version: 2,
            fromSchema: { postgres: sourceSql },
            schema: { postgres: destination },
            sql: `CREATE INDEX ${index}_one ON pool_fixture (value);
        ${pause ? "SELECT pg_sleep(30);" : ""}
        CREATE INDEX ${index}_two ON pool_fixture (id, value);
        UPDATE schema_meta SET schema_version = 2;`,
          },
        ]
      : [],
  };
}
async function openVersion(anchorPath: string, target: boolean, index: string, pause = false) {
  const { openEngineStore, readEngineAnchor } =
    await import("../../src/infra/database-engine/open.js");
  const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
  const anchor = openNodeSqliteDatabase(anchorPath);
  try {
    const db = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor,
        schema: schema(target, index, pause),
        input: selection.postgres,
        openSqlite() {
          throw new Error("Unexpected SQLite bootstrap");
        },
        prepareAnchor() {},
        inspectSqlite() {
          admitSqliteSchema(anchor);
          return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
        },
      }),
    );
    assert.ok(db instanceof PostgresSyncConnection);
    return {
      db,
      anchor,
      close: () => {
        db.close();
        anchor.close();
      },
    };
  } catch (error) {
    anchor.close();
    throw error;
  }
}
async function subprocess(mode: string, extra: Record<string, string>) {
  const args = process.versions.bun
    ? []
    : ["--import", new URL("../tsx.mjs", import.meta.url).href];
  const processChild = spawn(process.execPath, [...args, fileURLToPath(self), "--mode", mode], {
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processChild.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  processChild.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(processChild, "exit");
  if (code !== 0) {
    // Child failures are kept local; do not copy DSNs or PostgreSQL row data into reports.
    throw new Error(
      `Synthetic ${mode} child failed (${String(code)}): ${stderr.replaceAll(dsn!, "[DSN]")}`,
    );
  }
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

if (child?.kind === "transfer") {
  const current = open();
  try {
    check(current.db);
    const incoming = createPostgresPoolEndpoints();
    assert.ok(incoming);
    bindPostgresPool(incoming);
    check(current.db);
  } finally {
    current.close();
  }
  if (child.depth === 1) {
    const nested = transferredWorker(2);
    try {
      assert.deepEqual(await waitMessage(nested), { depth: 2, direct: true });
    } finally {
      await nested.terminate();
    }
  }
  parentPort!.postMessage({ depth: child.depth, direct: true }, []);
  parentPort!.close();
} else if (child?.kind === "fault") {
  const control = child.started ? new Int32Array(child.started) : undefined;
  const client = child.index ? new Client({ connectionString: dsn }) : undefined;
  await client?.connect();
  parentPort!.postMessage("ready", []);
  if (client) {
    const deadline = performance.now() + 30_000;
    for (;;) {
      const result = await client.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE $1) AS ready",
        [`%${child.index}%`],
      );
      if (result.rows[0].ready === true) {
        break;
      }
      assert.ok(
        performance.now() < deadline,
        "Migration did not reach the first index before crash",
      );
      await delay(10);
    }
  } else {
    await delay(100);
    assert.equal(Atomics.load(control!, 0), 1, "MAIN must already be inside synchronous admission");
    Atomics.store(control!, 1, 1);
  }
  // Corrupt the private setup channel to force an actual unhandled service failure,
  // without adding a production fault-injection API or replacing the bridge worker.
  child.port.postMessage({ connection: null }, []);
  child.port.close();
  await client?.end();
  parentPort!.postMessage("crashed", []);
  parentPort!.close();
} else if (child?.kind === "task") {
  const { serveWorkerTasks } = await import("../../src/infra/worker-task-server.js");
  serveWorkerTasks<TaskReply, Task>(
    (input) => {
      const current = open();
      try {
        if (input.sleep) {
          current.db.query(`SELECT pg_sleep(30) /* ${input.marker} */`);
        }
        check(current.db);
        return { ok: true };
      } catch {
        // History owners encode errors. The shared task server must still retire
        // the failed SQL host instead of returning its stale service endpoints.
        return { ok: false, error: "query failed" };
      } finally {
        current.close();
      }
    },
    { idleGc: false },
  );
} else {
  const { values } = parseArgs({ options: { mode: { type: "string" } } });
  const mode = values.mode;
  if (mode === "transfer") {
    await withDatabaseEngineSelection(selection, () =>
      preparePostgresPoolForUpdate("openclaw doctor --fix"),
    );
    const first = open();
    try {
      check(first.db);
    } finally {
      first.close();
    }
    const worker = transferredWorker(1);
    try {
      assert.deepEqual(await waitMessage(worker), { depth: 1, direct: true });
      report({ creation: true, nested: true, direct: true });
    } finally {
      await worker.terminate();
      await closePostgresPool();
    }
  } else if (mode === "crash") {
    await withDatabaseEngineSelection(selection, () =>
      preparePostgresPoolForUpdate("openclaw update repair"),
    );
    const current = open();
    const control = new SharedArrayBuffer(8);
    const fault = await faultWorker(0, { started: control });
    const counters = new Int32Array(control);
    let failure: unknown;
    const start = performance.now();
    Atomics.store(counters, 0, 1);
    try {
      withEngineStoreAdmission(() => current.db.query("SELECT pg_sleep(30)"));
    } catch (error) {
      failure = error;
    }
    const milliseconds = performance.now() - start;
    Atomics.store(counters, 0, 2);
    try {
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /outcome unknown/);
      assert.match(failure.message, /openclaw update repair/);
      assert.equal(Atomics.load(counters, 1), 1);
      assert.ok(
        milliseconds < 120_000,
        "Crashed service must wake MAIN before its request deadline",
      );
      report({
        mainBlocked: true,
        crashWakeMs: milliseconds,
        unknownOutcome: true,
        nextStep: true,
      });
    } finally {
      current.close();
      await fault.terminate();
      await closePostgresPool();
    }
  } else if (mode === "hang" || mode === "service-hang") {
    const entered = new SharedArrayBuffer(4);
    if (mode === "service-hang") {
      // A proof-only wrapper hangs a genuine service's event loop at one synthetic query.
      // All connection and request handling before that point is production code.
      const native = createRequire(import.meta.url)(
        "node:worker_threads",
      ) as typeof import("node:worker_threads");
      const NativeWorker = native.Worker;
      native.Worker = class extends NativeWorker {
        constructor(
          filename: string | URL,
          options: import("node:worker_threads").WorkerOptions = {},
        ) {
          const service = /postgres-sync\/bridge\.worker\.[cm]?[jt]s$/.test(String(filename));
          super(
            service ? new URL("./pg-pool-hang.worker.mjs", self) : filename,
            service
              ? {
                  ...options,
                  workerData: {
                    ...options.workerData,
                    proofServiceUrl: String(filename),
                    proofEntered: entered,
                  },
                }
              : options,
          );
        }
      };
      syncBuiltinESMExports();
    }
    await withDatabaseEngineSelection(selection, () =>
      preparePostgresPoolForUpdate("openclaw doctor --fix"),
    );
    const current = open("public", { statementTimeoutMs: 0 });
    let failure: unknown;
    const start = performance.now();
    try {
      withEngineStoreAdmission(() =>
        current.db.query(
          mode === "hang" ? "SELECT pg_sleep(150)" : "SELECT 424242 AS pg_pool_service_hang",
        ),
      );
    } catch (error) {
      failure = error;
    }
    const milliseconds = performance.now() - start;
    try {
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /outcome unknown/);
      assert.match(failure.message, /openclaw doctor --fix/);
      assert.ok(
        milliseconds >= 119_000 && milliseconds < 121_000,
        "Unanswered query must use the existing 120s deadline",
      );
      if (mode === "service-hang") {
        assert.equal(Atomics.load(new Int32Array(entered), 0), 1);
      }
      report({
        mainBlocked: true,
        serviceEventLoopHung: mode === "service-hang",
        withheldReplyMs: milliseconds,
        deadlineMs: 120_000,
        unknownOutcome: true,
        nextStep: true,
      });
    } finally {
      current.close();
      await closePostgresPool();
    }
  } else if (mode === "migration-attempt") {
    installDatabaseProcessRole("cli-oneshot");
    const anchorPath = process.env.PGFOOTPRINT_ANCHOR;
    const index = process.env.PGFOOTPRINT_INDEX;
    assert.ok(anchorPath && index);
    await withDatabaseEngineSelection(selection, () =>
      preparePostgresPoolForUpdate("openclaw doctor --fix"),
    );
    const fault =
      process.env.PGFOOTPRINT_KILL === "1" ? await faultWorker(0, { index }) : undefined;
    try {
      if (fault) {
        await assert.rejects(openVersion(anchorPath, true, index, true), /openclaw doctor --fix/);
        for (let i = 0; i < 3; i++) {
          const surviving = open();
          check(surviving.db);
          surviving.close();
        }
        assert.throws(open, /unavailable.*openclaw doctor --fix/);
        report({ migrationInterrupted: true, nextStep: true, noCrashReplacement: true });
      } else {
        const migrated = await openVersion(anchorPath, true, index);
        try {
          assert.equal(
            migrated.db.prepare("SELECT version FROM openclaw_schema_meta").get()?.version,
            2,
          );
        } finally {
          migrated.close();
        }
        report({ migrationCompleted: true });
      }
    } finally {
      await fault?.terminate();
      await closePostgresPool();
    }
  } else if (mode === "migration") {
    const root = process.env.TMPDIR;
    assert.ok(
      root && root.includes("/dbasync-campaign/tmp/pgfootprint"),
      "Use the lane's internal TMPDIR",
    );
    const fixtureRoot = path.join(root, `pool-lifecycle-${randomUUID()}`);
    mkdirSync(fixtureRoot);
    const anchorPath = path.join(fixtureRoot, "anchor.sqlite");
    const index = `pool_index_${randomUUID().replaceAll("-", "")}`;
    const original = await openVersion(anchorPath, false, index);
    const namespace = original.db.schema;
    original.close();
    await closePostgresPool();
    const client = new Client({ connectionString: dsn });
    await client.connect();
    try {
      const result = await subprocess("migration-attempt", {
        PGFOOTPRINT_ANCHOR: anchorPath,
        PGFOOTPRINT_INDEX: index,
        PGFOOTPRINT_KILL: "1",
      });
      assert.equal(result.migrationInterrupted, true);
      const version = await client.query(`SELECT version FROM "${namespace}".openclaw_schema_meta`);
      assert.equal(Number(version.rows[0].version), 1);
      const row = await client.query(`SELECT schema_version FROM "${namespace}".schema_meta`);
      assert.equal(Number(row.rows[0].schema_version), 1);
      const indexes = await client.query(
        "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2)",
        [namespace, [`${index}_one`, `${index}_two`]],
      );
      assert.equal(indexes.rows[0].count, 0);
      const rerun = await subprocess("migration-attempt", {
        PGFOOTPRINT_ANCHOR: anchorPath,
        PGFOOTPRINT_INDEX: index,
        PGFOOTPRINT_KILL: "0",
      });
      assert.equal(rerun.migrationCompleted, true);
      const after = await client.query(
        "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2)",
        [namespace, [`${index}_one`, `${index}_two`]],
      );
      assert.equal(after.rows[0].count, 2);
      report({
        doctorStyle: true,
        productionVersionedAdmission: true,
        killedAfterFirstIndex: true,
        versionUnchanged: true,
        noPartialIndexes: true,
        rerunCompleted: true,
      });
    } finally {
      await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
      await client.end();
      rmSync(fixtureRoot, { recursive: true });
    }
  } else if (mode === "gateway") {
    const { WorkerTaskPool } = await import("../../src/infra/worker-task-pool.js");
    const pool = new WorkerTaskPool<Task, TaskReply>({
      workerUrl: self,
      workerOptions: { workerData: { kind: "task" } },
      maxWorkers: 1,
    });
    const index = randomUUID().replaceAll("-", "");
    const before = poolSnapshot();
    const fault = await faultWorker(0, { index });
    try {
      await assert.rejects(
        withDatabaseEngineSelection(selection, () =>
          pool.run({ sleep: true, marker: index }, { timeoutMs: 60_000 }),
        ),
      );
      await delay(25);
      for (let attempt = 0; attempt < 4; attempt++) {
        assert.deepEqual(
          await withDatabaseEngineSelection(selection, () =>
            pool.run({ sleep: false }, { timeoutMs: 60_000 }),
          ),
          { ok: true },
        );
      }
      assertPoolReplaced(before);
      report({
        productionTaskLifecycle: true,
        failedHostRetired: true,
        replacementHostSucceeded: true,
        replacedServiceSlotZeroSucceeded: true,
      });
    } finally {
      await fault.terminate();
      await pool.close();
      await closePostgresPool();
    }
  } else if (mode === "broker") {
    const { SqliteWorkerBroker } = await import("../../src/infra/sqlite-worker-broker.js");
    const { initializeSqliteRuntimeCapabilities } =
      await import("../../src/infra/bun-sqlite-library.js");
    await initializeSqliteRuntimeCapabilities();
    const root = process.env.TMPDIR;
    assert.ok(root && root.includes("/dbasync-campaign/tmp/pgfootprint"));
    const fixtureRoot = path.join(root, `pool-lifecycle-${randomUUID()}`);
    mkdirSync(fixtureRoot);
    const broker = new SqliteWorkerBroker();
    const stores: SqliteWorkerStore<PoolFixtureOperations>[] = [];
    async function openBroker(sqliteOnly = false) {
      // No installed config at the SQLite-only open: the later PG config arrives
      // at an existing carrier, as it does during offline initialization.
      const selected = sqliteOnly ? undefined : selection;
      const openStore = () =>
        broker.open<PoolFixtureOperations>(
          {
            moduleUrl: new URL("./pg-pool-broker.fixture.mts", self),
            databasePath: path.join(fixtureRoot, `anchor-${stores.length}.sqlite`),
            input: { sqliteOnly },
          },
          {
            ...(selected ? { databaseEngineSelection: selected } : {}),
            environment: { OPENCLAW_STATE_DIR: fixtureRoot },
          },
          undefined,
          { carrierClass: "shared-state" },
        );
      const store = await (selected
        ? withDatabaseEngineSelection(selected, openStore)
        : openStore());
      assert.ok(store);
      stores.push(store);
      return store;
    }
    let fault: Worker | undefined;
    try {
      const sqlite = await openBroker(true);
      const first = await sqlite.execute({ type: "query", input: {} });
      assert.equal(first.postgres, false);
      const before = poolSnapshot();
      const postgres = await openBroker();
      const pgFirst = await postgres.execute({ type: "query", input: {} });
      assert.equal(pgFirst.postgres, true);
      assert.equal(first.worker, pgFirst.worker, "First PG dispatch must reuse the SQLite carrier");
      const index = randomUUID().replaceAll("-", "");
      fault = await faultWorker(0, { index });
      await assert.rejects(
        postgres.execute({ type: "query", input: { sleep: true, marker: index } }),
        /outcome unknown/,
      );
      for (let attempt = 0; attempt < 4; attempt++) {
        const fresh = await openBroker();
        const result = await fresh.execute({ type: "query", input: {} });
        assert.equal(result.postgres, true);
        assert.notEqual(result.worker, first.worker, "Failed carrier must retire before reuse");
      }
      assertPoolReplaced(before);
      report({
        productionBrokerLifecycle: true,
        firstPgDispatchReusedSqliteCarrier: true,
        failedCarrierRetired: true,
        replacedServiceSlotZeroSucceeded: true,
      });
    } finally {
      await fault?.terminate();
      await Promise.all(stores.map((store) => store.close()));
      await broker.close();
      await closePostgresPool();
      rmSync(fixtureRoot, { recursive: true });
    }
  } else {
    throw new Error("Use --mode transfer|crash|hang|service-hang|migration|gateway|broker");
  }
}
