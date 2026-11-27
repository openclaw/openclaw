// Run from the source checkout under test; this file may be copied outside that checkout.
// Node: node --import ./scripts/tsx.mjs /path/to/pg-pool-topology.mts --cell same-service
// Bun: bun /path/to/pg-pool-topology.mts --cell all-saturated
// PGFOOTPRINT_DSN must point at an owned, synthetic, loopback PostgreSQL server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { DatabaseEngineSelection } from "../../src/infra/database-engine/types.js";
import type { PostgresPoolEndpoints } from "../../src/infra/postgres-sync/pool-state.js";

type Pool = typeof import("../../src/infra/postgres-sync/pool.js");
type Counter = { threadId: number; count: Int32Array };
type Role = "background" | "foreground";
type Cell = "idle" | "ordinary-four" | "same-service" | "all-saturated";
type ChildData = { client: number; fillers: number; postgresPool?: PostgresPoolEndpoints };
type Request =
  | { id: number; operation: "open" | "warm" | "close" }
  | {
      id: number;
      operation: "measure";
      gate: SharedArrayBuffer;
      durationMs: number;
      role: Role;
      sql: string;
    };

const source = (relative: string) => pathToFileURL(path.resolve(relative)).href;
const { withEngineStoreAdmission } = (await import(
  source("src/infra/database-engine/admission-scope.ts")
)) as typeof import("../../src/infra/database-engine/admission-scope.js");
const { withDatabaseEngineSelection } = (await import(
  source("src/infra/database-engine/context.ts")
)) as typeof import("../../src/infra/database-engine/context.js");
const { getTrackedPostgresBridgeCounters } = (await import(
  source("src/infra/worker-cpu.ts")
)) as typeof import("../../src/infra/worker-cpu.js");
const { PostgresSyncConnection } = (await import(
  source("src/infra/postgres-sync/connection.ts")
)) as typeof import("../../src/infra/postgres-sync/connection.js");
const { resolveRuntimeWorkerThreadExecArgv } = (await import(
  source("src/infra/runtime-worker-url.ts")
)) as typeof import("../../src/infra/runtime-worker-url.js");
const pool: Pool | undefined = existsSync(path.resolve("src/infra/postgres-sync/pool.ts"))
  ? await import(source("src/infra/postgres-sync/pool.ts"))
  : undefined;
const self = new URL(import.meta.url);
const parsedDsn = new URL(process.env.PGFOOTPRINT_DSN ?? "invalid:");
if (
  !["postgres:", "postgresql:"].includes(parsedDsn.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedDsn.hostname)
) {
  throw new Error("PGFOOTPRINT_DSN must name the owned loopback synthetic fixture");
}
parsedDsn.searchParams.set("application_name", "openclaw-pg-pool-topology");
const dsn = parsedDsn.href;
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
  postgres: { connection: dsn, schemaPrefix: "pg_pool_topology" },
};

function quantiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    samples: sorted.length,
    min: at(0),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: at(1),
  };
}
function bridgeCounters(): Counter[] {
  return getTrackedPostgresBridgeCounters();
}

if (!isMainThread) {
  const data: ChildData = workerData;
  const connections: InstanceType<typeof PostgresSyncConnection>[] = [];
  const anchors: DatabaseSync[] = [];
  parentPort!.on("message", (request: Request) => {
    try {
      if (request.operation === "open") {
        const started = performance.now();
        for (let index = 0; index <= data.fillers; index++) {
          const anchor = new DatabaseSync(":memory:");
          anchors.push(anchor);
          const connection = withEngineStoreAdmission(
            () =>
              new PostgresSyncConnection(
                dsn,
                "public",
                anchor,
                `pg-pool-topology-${data.client}-${index}`,
                { statementTimeoutMs: 30_000 },
              ),
          );
          connections.push(connection);
          if (index === 0) {
            connection.prepare("SELECT 1 AS ok").get();
            parentPort!.postMessage(
              {
                firstRequest: true,
                client: data.client,
                milliseconds: performance.now() - started,
              },
              [],
            );
          }
        }
        parentPort!.postMessage({ id: request.id, result: { counters: bridgeCounters() } }, []);
      } else if (request.operation === "warm") {
        const primary = connections.at(0);
        assert.ok(primary);
        for (let sample = 0; sample < 5; sample++) {
          primary.prepare("SELECT 1 AS ok").get();
        }
        parentPort!.postMessage({ id: request.id, result: null }, []);
      } else if (request.operation === "measure") {
        const gate = new Int32Array(request.gate);
        const primary = connections.at(0);
        assert.ok(primary);
        const statement = primary.prepare(request.sql);
        Atomics.add(gate, 0, 1);
        Atomics.notify(gate, 0);
        Atomics.wait(gate, 1, 0);
        const deadline = performance.now() + request.durationMs;
        const latencies: number[] = [];
        const cpuStart = process.threadCpuUsage();
        while (performance.now() < deadline) {
          const started = performance.now();
          // Decode the full normal result in the SQL-owning worker. No rows cross the
          // workload-control channel, which is not part of the production SQL transport.
          statement.all();
          latencies.push(performance.now() - started);
        }
        parentPort!.postMessage(
          {
            id: request.id,
            result: {
              client: data.client,
              role: request.role,
              latencyMs: quantiles(latencies),
              queryCalls: latencies.length,
              hostCpu: process.threadCpuUsage(cpuStart),
            },
          },
          [],
        );
      } else {
        for (const connection of connections) {
          connection.close();
        }
        for (const anchor of anchors) {
          anchor.close();
        }
        void pool?.closePostgresPool().then(() => {
          parentPort!.postMessage({ id: request.id, result: null }, []);
          parentPort!.close();
        });
        if (!pool) {
          parentPort!.postMessage({ id: request.id, result: null }, []);
          parentPort!.close();
        }
      }
    } catch {
      // Never copy PostgreSQL errors, DSNs, bound values, or result rows to reports.
      parentPort!.postMessage({ id: request.id, failed: true }, []);
    }
  });
  parentPort!.postMessage({ ready: true }, []);
} else {
  const { values } = parseArgs({
    options: {
      cell: { type: "string", default: "idle" },
      kind: { type: "string", default: "slow" },
      "idle-ms": { type: "string", default: "10000" },
      "duration-ms": { type: "string", default: "10000" },
      output: { type: "string" },
      "external-rss": { type: "boolean", default: false },
      "setup-only": { type: "boolean", default: false },
    },
  });
  const cell = values.cell as Cell;
  const idleMs = Number(values["idle-ms"]);
  const durationMs = Number(values["duration-ms"]);
  if (
    !["idle", "ordinary-four", "same-service", "all-saturated"].includes(cell) ||
    !["slow", "large"].includes(values.kind) ||
    !values.output ||
    !Number.isFinite(idleMs) ||
    idleMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 1000
  ) {
    throw new Error(
      "Use --cell idle|ordinary-four|same-service|all-saturated, --kind slow|large, --output",
    );
  }
  if (process.env.NODE_OPTIONS) {
    throw new Error("Run observer-free: unset NODE_OPTIONS");
  }
  const activeClients = cell === "same-service" || cell === "ordinary-four" ? 4 : 20;
  const fillers = cell === "same-service" ? 3 : 0;
  const backgroundClients = cell === "idle" ? 0 : cell === "all-saturated" ? 4 : 1;
  const workers: Worker[] = [];
  const firstRequestMs: { client: number; milliseconds: number }[] = [];
  const counters = new Map<number, Int32Array>();
  const endpoints: {
    request: (operation: Request["operation"], extra?: Partial<Request>) => Promise<unknown>;
  }[] = [];
  let closing = false;
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Set<(error: Error) => void>();
  const fail = () => {
    failure ??= new Error("Synthetic production topology operation failed");
    for (const reject of pending) {
      reject(failure);
    }
    pending.clear();
  };
  const phase = () => ({ cpu: process.cpuUsage(), mainCpu: process.threadCpuUsage() });
  const delta = (before: ReturnType<typeof phase>) => ({
    cpu: process.cpuUsage(before.cpu),
    mainCpu: process.threadCpuUsage(before.mainCpu),
  });
  const initialCpu = phase();
  const started = performance.now();
  const watchdog = setTimeout(fail, 120_000);
  watchdog.unref();
  const pg = createRequire(path.resolve("package.json"))("pg") as typeof import("pg");
  const monitorDsn = new URL(dsn);
  monitorDsn.searchParams.set("application_name", "openclaw-pg-pool-topology-monitor");
  const monitor = new pg.Client({ connectionString: monitorDsn.href });
  try {
    await monitor.connect();
    for (let client = 0; client < activeClients; client++) {
      const inherited = withDatabaseEngineSelection(selection, () =>
        pool?.createPostgresPoolEndpoints(),
      );
      const worker = new Worker(self, {
        workerData: { client, fillers, postgresPool: inherited } satisfies ChildData,
        transferList: pool?.postgresPoolTransferList(inherited) ?? [],
        execArgv: resolveRuntimeWorkerThreadExecArgv(self),
      });
      const requests = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();
      const ready = new Promise<void>((resolve, reject) => {
        pending.add(reject);
        worker.on("message", (message) => {
          if (message.ready) {
            pending.delete(reject);
            resolve();
          } else if (message.firstRequest) {
            firstRequestMs.push({ client: message.client, milliseconds: message.milliseconds });
          } else {
            const request = requests.get(message.id);
            if (!request) {
              return;
            }
            pending.delete(request.reject);
            requests.delete(message.id);
            if (message.failed) {
              request.reject(new Error("Synthetic production topology query failed"));
            } else {
              request.resolve(message.result);
            }
          }
        });
      });
      worker.on("error", fail);
      worker.on("exit", () => {
        if (!closing) {
          fail();
        }
      });
      workers.push(worker);
      const endpoint = {
        request(operation, extra = {}) {
          if (failure) {
            return Promise.reject(failure);
          }
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            requests.set(id, { resolve, reject });
            pending.add(reject);
            worker.postMessage({ ...extra, operation, id }, []);
          });
        },
      } satisfies (typeof endpoints)[number];
      endpoints.push(endpoint);
      await ready;
      // Sequential connection admission fixes placement: same-service primaries
      // occupy ordinals 0,4,8,12 with the real, unmodified round-robin allocator.
      const opened = (await endpoint.request("open")) as { counters: Counter[] };
      for (const counter of opened.counters) {
        counters.set(counter.threadId, counter.count);
      }
    }
    for (const counter of bridgeCounters()) {
      counters.set(counter.threadId, counter.count);
    }
    const startupCpu = delta(initialCpu);
    const readyMs = performance.now() - started;
    const startupBridgeLaunches = [...counters.values()].reduce(
      (sum, count) => sum + Atomics.load(count, 0),
      0,
    );
    if (startupBridgeLaunches !== (pool ? 4 : activeClients * (fillers + 1))) {
      throw new Error("Synthetic bridge census did not match the physical topology");
    }
    await Promise.all(endpoints.map((endpoint) => endpoint.request("warm")));
    await delay(idleMs);
    const backend = await monitor.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'openclaw-pg-pool-topology'",
    );
    const databaseBackends = Number(backend.rows.at(0)?.count);
    if (databaseBackends !== activeClients * (fillers + 1)) {
      throw new Error("Synthetic connection census did not match admitted clients");
    }
    const threads =
      process.platform === "darwin"
        ? execFileSync("ps", ["-M", "-p", String(process.pid), "-o", "pid="], { encoding: "utf8" })
            .trim()
            .split("\n").length
        : Number(
            execFileSync("ps", ["-p", String(process.pid), "-o", "nlwp="], {
              encoding: "utf8",
            }).trim(),
          );
    process.stdout.write(JSON.stringify({ phase: "idle", pid: process.pid, cell }) + "\n");
    const rss: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      rss.push(process.memoryUsage().rss);
      await delay(200);
    }
    if (values["external-rss"]) {
      await once(process.stdin, "data", { signal: AbortSignal.timeout(120_000) });
      process.stdin.pause();
    }
    const measureCpu = phase();
    let measurements: unknown[] = [];
    if (cell !== "idle" && !values["setup-only"]) {
      const gate = new SharedArrayBuffer(8);
      const control = new Int32Array(gate);
      const running = endpoints.map((endpoint, client) =>
        endpoint.request("measure", {
          gate,
          durationMs,
          role: client < backgroundClients ? "background" : "foreground",
          sql:
            client >= backgroundClients
              ? "SELECT 1 AS ok"
              : values.kind === "slow"
                ? "SELECT pg_sleep(0.2)"
                : "SELECT repeat('x', 8192) FROM generate_series(1, 1024)",
        }),
      );
      const complete = Promise.all(running);
      while (Atomics.load(control, 0) !== activeClients) {
        if (failure) {
          throw failure;
        }
        await delay(1);
      }
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      measurements = await complete;
    }
    const measuredCpu = delta(measureCpu);
    writeFileSync(
      values.output,
      JSON.stringify(
        {
          runtime: process.versions.bun ? "bun" : "node",
          sourceRoot: process.cwd(),
          productionPool: Boolean(pool),
          cell,
          kind: values.kind,
          setupOnly: values["setup-only"],
          activeClients,
          fillerClients: activeClients * fillers,
          logicalConnectionOpens: activeClients * (fillers + 1),
          warmupQueryCalls: activeClients * 5,
          placement: Array.from({ length: activeClients }, (_, client) => ({
            client,
            role: client < backgroundClients ? "background" : "foreground",
            physicalService: pool ? (client * (fillers + 1)) % 4 : client * (fillers + 1),
          })),
          databaseBackends,
          startupBridgeLaunches,
          threads,
          readyMs,
          firstRequestMs,
          firstRequestSummaryMs: quantiles(firstRequestMs.map(({ milliseconds }) => milliseconds)),
          startupCpu,
          measuredCpu,
          idleRssBytes: rss,
          measurements,
          load: loadavg(),
          note: "Actual PostgresSyncConnection request/reply and row decoding; control channel returns only counts and timings. same-service uses 12 real idle filler connections to place 4 active clients on one unchanged round-robin ordinal.",
        },
        null,
        2,
      ) + "\n",
    );
    closing = true;
    await Promise.all(endpoints.map((endpoint) => endpoint.request("close")));
  } finally {
    closing = true;
    clearTimeout(watchdog);
    await Promise.all(workers.map((worker) => worker.terminate()));
    await pool?.closePostgresPool();
    await monitor.end();
  }
}
